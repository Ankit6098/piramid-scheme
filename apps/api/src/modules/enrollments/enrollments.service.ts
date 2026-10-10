import { Injectable, Logger } from '@nestjs/common';
import {
  ErrorCode,
  type ActivateEnrollmentInput,
  type AdminEnrollmentDto,
  type ApiPage,
  type CreateEnrollmentInput,
  type EnrollmentStatus,
  type ListAdminEnrollmentsQuery,
  type ListMyEnrollmentsQuery,
  type MyEnrollmentDto,
} from '@app/shared';
import { z } from 'zod';
import {
  AppError,
  assertProgramAccess,
  AuditService,
  conflict,
  decodeCursor,
  inspectDbError,
  invalidState,
  notFound,
  OutboxService,
  paginate,
  PrismaService,
  programScopeFilter,
  validationFailed,
  type AuthContext,
  type Db,
  type Tx,
} from '../../common';
import { AppConfig } from '../../config/app-config';
import type { EnrollmentStatus as DbEnrollmentStatus, Prisma } from '../../generated/prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import { isEnrollmentWindowOpen } from '../programs/domain/program-rules';
import { computeCoverage, decideCancellation, evaluateEligibility, parseEligibility } from './domain/enrollment-rules';
import {
  adminEnrollmentInclude,
  enrollmentInclude,
  parseSnapshot,
  toAdminEnrollmentDto,
  toMyEnrollmentDto,
} from './enrollments.mapper';

export interface EligibleEnrollmentRef {
  enrollmentId: string;
}

const cursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });

/** Advisory lock namespace serializing enrollment writes per (member, program). */
const ENROLLMENT_LOCK_CLASS = 7302;
const EXPIRY_BATCH = 200;

type Notice = { type: string; title: string; body: string; emailStatus?: 'ACTIVE' | 'REJECTED' | 'CANCELLED' | 'EXPIRED' | 'PENDING' };

function statusList(status: EnrollmentStatus | EnrollmentStatus[] | undefined): DbEnrollmentStatus[] | undefined {
  if (status === undefined) return undefined;
  return Array.isArray(status) ? status : [status];
}

function cursorWhere(cursor: { createdAt: string; id: string } | undefined): Prisma.ProgramEnrollmentWhereInput {
  if (!cursor) return {};
  return {
    OR: [{ createdAt: { lt: new Date(cursor.createdAt) } }, { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } }],
  };
}

/**
 * Enrollments (business rules §5). Holds the CROSS-MODULE CONTRACT `findEligibleEnrollments` used by
 * the reward engine, plus the member and admin enrollment use cases and the expiry sweep.
 *
 * Option prices pay for the plan (product/service access). An enrollment or its payment is never a
 * reward trigger.
 */
@Injectable()
export class EnrollmentsService {
  private readonly logger = new Logger(EnrollmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly outbox: OutboxService,
    private readonly config: AppConfig,
  ) {}

  /**
   * For each of `userIds`, finds an enrollment in `programId` whose coverage made the member
   * reward-eligible at the sale instant `at`. Determined by `at`, never by when processing runs:
   * - `eligibilityStatus = ELIGIBLE` and `effectiveFrom ≤ at < effectiveTo`, and
   * - `status IN (ACTIVE, EXPIRED)`, or `status = CANCELLED` with `at < cancelledAt`.
   *
   * @returns Map keyed by userId; members without such an enrollment are absent. One query.
   */
  async findEligibleEnrollments(
    db: Db,
    programId: string,
    userIds: string[],
    at: Date,
  ): Promise<Map<string, EligibleEnrollmentRef>> {
    const result = new Map<string, EligibleEnrollmentRef>();
    if (userIds.length === 0) return result;
    const rows = await db.programEnrollment.findMany({
      where: {
        programId,
        userId: { in: userIds },
        eligibilityStatus: 'ELIGIBLE',
        effectiveFrom: { lte: at },
        effectiveTo: { gt: at },
        OR: [{ status: { in: ['ACTIVE', 'EXPIRED'] } }, { status: 'CANCELLED', cancelledAt: { gt: at } }],
      },
      select: { id: true, userId: true },
      orderBy: { effectiveFrom: 'asc' },
    });
    for (const row of rows) {
      if (!result.has(row.userId)) result.set(row.userId, { enrollmentId: row.id });
    }
    return result;
  }

  // ─── member use cases ──────────────────────────────────────────────────────

  /**
   * Enrolls the caller: program ACTIVE with an open window, option active, eligibility rules met,
   * no PENDING enrollment and no queued renewal. Free plans activate immediately (coverage from the
   * end of the current period, if any); paid plans wait for an admin to record the offline payment.
   */
  async enroll(auth: AuthContext, programId: string, input: CreateEnrollmentInput): Promise<MyEnrollmentDto> {
    try {
      return await this.prisma.runInTransaction(async (tx) => {
        const now = new Date();
        await this.lockMemberProgram(tx, auth.userId, programId);
        await tx.$executeRaw`SELECT 1 FROM "programs" WHERE "id" = ${programId}::uuid FOR SHARE`;
        const program = await tx.program.findUnique({ where: { id: programId } });
        if (!program || program.status === 'DRAFT') throw notFound('Program');
        if (program.status !== 'ACTIVE' || !isEnrollmentWindowOpen(program, now)) {
          throw new AppError(ErrorCode.ProgramNotEnrollable, 'This program is not open for enrollment right now', 409, {
            status: program.status,
            enrollmentOpensAt: program.enrollmentOpensAt.toISOString(),
            enrollmentClosesAt: program.enrollmentClosesAt?.toISOString() ?? null,
          });
        }
        if (input.termsVersion !== undefined && input.termsVersion !== program.termsVersion) {
          throw conflict('The program terms have changed. Please review the latest terms and try again.', {
            termsVersion: program.termsVersion,
          });
        }
        const option = await tx.programOption.findFirst({ where: { id: input.optionId, programId, isActive: true } });
        if (!option) {
          throw validationFailed('This plan is not available', {
            issues: [{ path: 'optionId', message: 'This plan is not available', code: 'custom' }],
          });
        }
        const user = await tx.user.findUniqueOrThrow({
          where: { id: auth.userId },
          select: { status: true, emailVerifiedAt: true, createdAt: true, sponsorRelationship: { select: { sponsorUserId: true } } },
        });
        if (user.status !== 'ACTIVE' || !user.emailVerifiedAt) {
          throw new AppError(ErrorCode.EmailNotVerified, 'Only active members with a verified email can enroll', 403);
        }
        const eligibility = evaluateEligibility(
          parseEligibility(program.eligibility),
          { createdAt: user.createdAt, hasSponsor: user.sponsorRelationship !== null },
          now,
        );
        if (!eligibility.eligible) {
          throw new AppError(ErrorCode.NotEligible, eligibility.reasons[0] ?? 'You are not eligible for this program', 409, {
            reasons: eligibility.reasons,
          });
        }
        const pending = await tx.programEnrollment.findFirst({
          where: { userId: auth.userId, programId, status: 'PENDING' },
          select: { id: true },
        });
        if (pending) {
          throw new AppError(
            ErrorCode.AlreadyEnrolled,
            'You already have an enrollment waiting for activation in this program',
            409,
            { enrollmentId: pending.id },
          );
        }
        const currentPeriodEnd = await this.currentPeriodEnd(tx, auth.userId, programId, now, { blockQueuedRenewal: true });

        const snapshot = {
          optionId: option.id,
          name: option.name,
          priceMinor: option.priceMinor.toString(),
          currencyCode: option.currencyCode,
          billingFrequency: option.billingFrequency,
          durationDays: option.durationDays,
          renewalPolicy: option.renewalPolicy,
        };
        const free = option.priceMinor === 0n;
        const coverage = free ? computeCoverage(now, currentPeriodEnd, option.durationDays) : null;
        const created = await tx.programEnrollment.create({
          data: {
            userId: auth.userId,
            programId,
            optionId: option.id,
            optionSnapshot: snapshot,
            termsVersion: program.termsVersion,
            sponsorUserId: user.sponsorRelationship?.sponsorUserId ?? null,
            ...(coverage
              ? { status: 'ACTIVE', eligibilityStatus: 'ELIGIBLE', ...coverage }
              : { status: 'PENDING', eligibilityStatus: 'PENDING_REVIEW' }),
          },
          include: enrollmentInclude,
        });
        await this.audit.record(tx, {
          action: 'enrollment.create',
          resourceType: 'enrollment',
          resourceId: created.id,
          programId,
          after: {
            status: created.status,
            optionId: option.id,
            priceMinor: option.priceMinor,
            termsVersion: program.termsVersion,
            effectiveFrom: created.effectiveFrom?.toISOString() ?? null,
            effectiveTo: created.effectiveTo?.toISOString() ?? null,
            renewal: currentPeriodEnd !== null,
          },
        });
        await this.notify(tx, created.id, auth.userId, null, program.name, option.name, {
          type: free ? 'enrollment.activated' : 'enrollment.pending',
          title: free ? `You're enrolled in ${program.name}` : `Enrollment received: ${program.name}`,
          body: free
            ? `Your ${option.name} plan is active.`
            : `We'll activate your ${option.name} plan once your payment has been confirmed by the program team.`,
        });
        return toMyEnrollmentDto(created, now);
      });
    } catch (err) {
      throw this.mapEnrollmentConflict(err);
    }
  }

  async listMine(auth: AuthContext, query: ListMyEnrollmentsQuery): Promise<ApiPage<MyEnrollmentDto>> {
    const cursor = decodeCursor(query.cursor, cursorSchema);
    const statuses = statusList(query.status);
    const rows = await this.prisma.programEnrollment.findMany({
      where: {
        AND: [
          { userId: auth.userId },
          statuses ? { status: { in: statuses } } : {},
          query.programId ? { programId: query.programId } : {},
          cursorWhere(cursor),
        ],
      },
      include: enrollmentInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const now = new Date();
    return paginate(rows, query.limit, (r) => ({ createdAt: r.createdAt.toISOString(), id: r.id }), (r) => toMyEnrollmentDto(r, now));
  }

  /** Member cancellation of their own PENDING or running enrollment. */
  async cancelMine(auth: AuthContext, id: string, note?: string): Promise<MyEnrollmentDto> {
    return this.prisma.runInTransaction(async (tx) => {
      const row = await this.lockEnrollment(tx, id);
      if (row.userId !== auth.userId) throw notFound('Enrollment');
      const updated = await this.cancelInTx(tx, row, note?.trim() || 'Cancelled by the member');
      return toMyEnrollmentDto(updated);
    });
  }

  // ─── admin use cases ───────────────────────────────────────────────────────

  async adminList(auth: AuthContext, query: ListAdminEnrollmentsQuery): Promise<ApiPage<AdminEnrollmentDto>> {
    const scope = programScopeFilter(auth, 'write');
    const cursor = decodeCursor(query.cursor, cursorSchema);
    const statuses = statusList(query.status);
    const q = query.q;
    const rows = await this.prisma.programEnrollment.findMany({
      where: {
        AND: [
          scope === 'ALL' ? {} : { programId: { in: scope } },
          statuses ? { status: { in: statuses } } : {},
          query.programId ? { programId: query.programId } : {},
          query.userId ? { userId: query.userId } : {},
          q
            ? {
                OR: [
                  { user: { fullName: { contains: q, mode: 'insensitive' } } },
                  { user: { email: { contains: q.toLowerCase() } } },
                  { paymentReference: { contains: q, mode: 'insensitive' } },
                ],
              }
            : {},
          cursorWhere(cursor),
        ],
      },
      include: adminEnrollmentInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const now = new Date();
    return paginate(rows, query.limit, (r) => ({ createdAt: r.createdAt.toISOString(), id: r.id }), (r) => toAdminEnrollmentDto(r, now));
  }

  async adminGet(auth: AuthContext, id: string): Promise<AdminEnrollmentDto> {
    const row = await this.prisma.programEnrollment.findUnique({ where: { id }, include: adminEnrollmentInclude });
    if (!row) throw notFound('Enrollment');
    assertProgramAccess(auth, row.programId, 'write');
    return toAdminEnrollmentDto(row);
  }

  /**
   * Records the offline payment of a PENDING enrollment and activates it: coverage starts at
   * `max(now, end of the member's current period)` (renewal without a gap) and lasts the snapshot's
   * duration; eligibility becomes ELIGIBLE. The payment record is immutable afterwards.
   */
  async activate(auth: AuthContext, id: string, input: ActivateEnrollmentInput): Promise<AdminEnrollmentDto> {
    try {
      return await this.prisma.runInTransaction(async (tx) => {
        const now = new Date();
        const locked = await this.lockEnrollment(tx, id);
        assertProgramAccess(auth, locked.programId, 'write');
        if (locked.status !== 'PENDING') {
          throw invalidState(`Only pending enrollments can be activated (this one is ${locked.status.toLowerCase()})`, {
            status: locked.status,
          });
        }
        if (locked.program.status !== 'ACTIVE' && locked.program.status !== 'PAUSED') {
          throw invalidState('The program has ended. Reject the enrollment instead.', { programStatus: locked.program.status });
        }
        if (locked.user.status !== 'ACTIVE' || !locked.user.emailVerifiedAt) {
          throw invalidState('The member account is not active');
        }
        const snapshot = parseSnapshot(locked.optionSnapshot, { optionId: locked.optionId, currencyCode: locked.program.currencyCode });
        const price = BigInt(snapshot.priceMinor);
        const amount = BigInt(input.paymentAmountMinor);
        if (price > 0n && amount < price) {
          throw validationFailed('The amount received is less than the plan price', {
            issues: [{ path: 'paymentAmountMinor', message: 'Less than the plan price', code: 'custom' }],
            priceMinor: snapshot.priceMinor,
          });
        }
        const reference = input.paymentReference;
        const usedByEnrollment = await tx.programEnrollment.findFirst({ where: { paymentReference: reference }, select: { id: true } });
        const usedBySale = await tx.qualifyingEvent.findFirst({ where: { externalId: reference }, select: { id: true } });
        if (usedByEnrollment || usedBySale) {
          throw conflict('This payment reference has already been used', {
            issues: [{ path: 'paymentReference', message: 'Already used — payment references must be unique', code: 'custom' }],
          });
        }
        await this.lockMemberProgram(tx, locked.userId, locked.programId);
        const currentPeriodEnd = await this.currentPeriodEnd(tx, locked.userId, locked.programId, now, { excludeId: id });
        const coverage = computeCoverage(now, currentPeriodEnd, snapshot.durationDays);
        const updated = await tx.programEnrollment.update({
          where: { id },
          data: {
            status: 'ACTIVE',
            eligibilityStatus: 'ELIGIBLE',
            ...coverage,
            paymentReference: reference,
            paymentAmountMinor: amount,
            paymentRecordedAt: now,
            paymentRecordedById: auth.userId,
            statusReason: null,
          },
          include: adminEnrollmentInclude,
        });
        await this.audit.record(tx, {
          action: 'enrollment.activate',
          resourceType: 'enrollment',
          resourceId: id,
          programId: locked.programId,
          before: { status: 'PENDING' },
          after: {
            status: 'ACTIVE',
            effectiveFrom: coverage.effectiveFrom.toISOString(),
            effectiveTo: coverage.effectiveTo.toISOString(),
            paymentReference: reference,
            paymentAmountMinor: amount,
            renewal: currentPeriodEnd !== null,
          },
        });
        await this.notify(tx, id, locked.userId, locked.user.email, locked.program.name, snapshot.name, {
          type: 'enrollment.activated',
          title: `Your enrollment in ${locked.program.name} is active`,
          body: `Your payment was recorded and your ${snapshot.name} plan is now active.`,
          emailStatus: 'ACTIVE',
        });
        return toAdminEnrollmentDto(updated, now);
      });
    } catch (err) {
      throw this.mapEnrollmentConflict(err);
    }
  }

  async reject(auth: AuthContext, id: string, reason: string): Promise<AdminEnrollmentDto> {
    return this.prisma.runInTransaction(async (tx) => {
      const locked = await this.lockEnrollment(tx, id);
      assertProgramAccess(auth, locked.programId, 'write');
      if (locked.status !== 'PENDING') {
        throw invalidState(`Only pending enrollments can be rejected (this one is ${locked.status.toLowerCase()})`, {
          status: locked.status,
        });
      }
      const updated = await tx.programEnrollment.update({
        where: { id },
        data: { status: 'REJECTED', eligibilityStatus: 'INELIGIBLE', statusReason: reason },
        include: adminEnrollmentInclude,
      });
      await this.audit.record(tx, {
        action: 'enrollment.reject',
        resourceType: 'enrollment',
        resourceId: id,
        programId: locked.programId,
        before: { status: 'PENDING' },
        after: { status: 'REJECTED' },
        reason,
      });
      const snapshot = parseSnapshot(locked.optionSnapshot, { optionId: locked.optionId, currencyCode: locked.program.currencyCode });
      await this.notify(tx, id, locked.userId, locked.user.email, locked.program.name, snapshot.name, {
        type: 'enrollment.rejected',
        title: `Your enrollment in ${locked.program.name} was not approved`,
        body: reason,
        emailStatus: 'REJECTED',
      });
      return toAdminEnrollmentDto(updated);
    });
  }

  async adminCancel(auth: AuthContext, id: string, reason: string): Promise<AdminEnrollmentDto> {
    return this.prisma.runInTransaction(async (tx) => {
      const locked = await this.lockEnrollment(tx, id);
      assertProgramAccess(auth, locked.programId, 'write');
      await this.cancelInTx(tx, locked, reason, { notifyMember: true });
      const row = await tx.programEnrollment.findUniqueOrThrow({ where: { id }, include: adminEnrollmentInclude });
      return toAdminEnrollmentDto(row);
    });
  }

  // ─── scheduler ─────────────────────────────────────────────────────────────

  /**
   * Job `enrollments-expiry` (idempotent): ACTIVE enrollments whose coverage ended become EXPIRED
   * (eligibility is kept — it still proves coverage for sales inside the period). Audited as system.
   */
  async expireDue(now = new Date()): Promise<number> {
    let total = 0;
    for (let round = 0; round < 50; round++) {
      const count = await this.prisma.runInTransaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string; user_id: string; program_id: string; option_snapshot: unknown }>>`
          SELECT "id", "user_id", "program_id", "option_snapshot" FROM "program_enrollments"
           WHERE "status" = 'ACTIVE' AND "effective_to" <= ${now}
           ORDER BY "effective_to" ASC
           LIMIT ${EXPIRY_BATCH}
           FOR UPDATE SKIP LOCKED`;
        if (rows.length === 0) return 0;
        const ids = rows.map((r) => r.id);
        await tx.programEnrollment.updateMany({ where: { id: { in: ids }, status: 'ACTIVE' }, data: { status: 'EXPIRED' } });
        const programs = await tx.program.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.program_id))] } },
          select: { id: true, name: true },
        });
        const names = new Map(programs.map((p) => [p.id, p.name]));
        for (const r of rows) {
          const programName = names.get(r.program_id) ?? 'the program';
          const optionName = parseSnapshot(r.option_snapshot, { optionId: '', currencyCode: '' }).name;
          await this.audit.record(tx, {
            action: 'enrollment.expire',
            resourceType: 'enrollment',
            resourceId: r.id,
            programId: r.program_id,
            actorUserId: null,
            before: { status: 'ACTIVE' },
            after: { status: 'EXPIRED' },
          });
          await this.notify(tx, r.id, r.user_id, null, programName, optionName, {
            type: 'enrollment.expired',
            title: `Your ${optionName} plan has ended`,
            body: `Your enrollment in ${programName} has reached the end of its period.`,
          });
        }
        return rows.length;
      });
      total += count;
      if (count < EXPIRY_BATCH) break;
    }
    if (total > 0) this.logger.log({ expired: total }, 'enrollments expired');
    return total;
  }

  // ─── helpers ───────────────────────────────────────────────────────────────

  private async cancelInTx(
    tx: Tx,
    row: Awaited<ReturnType<EnrollmentsService['lockEnrollment']>>,
    reason: string,
    opts: { notifyMember?: boolean } = {},
  ) {
    const now = new Date();
    const decision = decideCancellation(row, now);
    if (!decision.ok) {
      throw invalidState(
        decision.reason === 'ENDED'
          ? 'This enrollment has already ended'
          : `This enrollment is ${row.status.toLowerCase()} and can no longer be cancelled`,
        { status: row.status },
      );
    }
    const effectiveToChanged = decision.effectiveTo?.getTime() !== row.effectiveTo?.getTime();
    const updated = await tx.programEnrollment.update({
      where: { id: row.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: now,
        statusReason: reason.slice(0, 500),
        ...(effectiveToChanged ? { effectiveTo: decision.effectiveTo } : {}),
        ...(row.status === 'PENDING' ? { eligibilityStatus: 'INELIGIBLE' } : {}),
      },
      include: enrollmentInclude,
    });
    await this.audit.record(tx, {
      action: 'enrollment.cancel',
      resourceType: 'enrollment',
      resourceId: row.id,
      programId: row.programId,
      before: { status: row.status, effectiveTo: row.effectiveTo?.toISOString() ?? null },
      after: { status: 'CANCELLED', effectiveTo: updated.effectiveTo?.toISOString() ?? null },
      reason,
    });
    if (opts.notifyMember) {
      const snapshot = parseSnapshot(row.optionSnapshot, { optionId: row.optionId, currencyCode: row.program.currencyCode });
      await this.notify(tx, row.id, row.userId, row.user.email, row.program.name, snapshot.name, {
        type: 'enrollment.cancelled',
        title: `Your enrollment in ${row.program.name} was cancelled`,
        body: reason,
        emailStatus: 'CANCELLED',
      });
    }
    return updated;
  }

  /** Row-locks an enrollment and loads what the use cases need. */
  private async lockEnrollment(tx: Tx, id: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "program_enrollments" WHERE "id" = ${id}::uuid FOR UPDATE`;
    if (rows.length === 0) throw notFound('Enrollment');
    return tx.programEnrollment.findUniqueOrThrow({
      where: { id },
      include: {
        program: { select: { id: true, name: true, status: true, currencyCode: true } },
        user: { select: { id: true, email: true, status: true, emailVerifiedAt: true } },
      },
    });
  }

  /** Serializes enrollment writes of one member in one program (renewal coverage, duplicates). */
  private async lockMemberProgram(tx: Tx, userId: string, programId: string): Promise<void> {
    const key = `${userId}:${programId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ENROLLMENT_LOCK_CLASS}::int, hashtext(${key}::text))`;
  }

  /**
   * End of the member's current (or queued) activated coverage in the program, or null. With
   * `blockQueuedRenewal`, a renewal that has not started yet (or a current plan that cannot be
   * renewed) rejects a new enrollment.
   */
  private async currentPeriodEnd(
    tx: Tx,
    userId: string,
    programId: string,
    now: Date,
    opts: { blockQueuedRenewal?: boolean; excludeId?: string } = {},
  ): Promise<Date | null> {
    const periods = await tx.programEnrollment.findMany({
      where: {
        userId,
        programId,
        status: 'ACTIVE',
        effectiveTo: { gt: now },
        ...(opts.excludeId ? { id: { not: opts.excludeId } } : {}),
      },
      select: { id: true, effectiveFrom: true, effectiveTo: true, optionSnapshot: true },
      orderBy: { effectiveTo: 'desc' },
    });
    const latest = periods[0];
    if (!latest?.effectiveTo) return null;
    if (opts.blockQueuedRenewal) {
      if (periods.some((p) => p.effectiveFrom && p.effectiveFrom.getTime() > now.getTime())) {
        throw new AppError(ErrorCode.AlreadyEnrolled, 'You already have a renewal queued for this program', 409, {
          enrollmentId: latest.id,
        });
      }
      const snapshot = parseSnapshot(latest.optionSnapshot, { optionId: '', currencyCode: '' });
      if (snapshot.renewalPolicy === 'NONE') {
        throw new AppError(
          ErrorCode.AlreadyEnrolled,
          'Your current plan cannot be renewed. You can enroll again after it ends.',
          409,
          { enrollmentId: latest.id, effectiveTo: latest.effectiveTo.toISOString() },
        );
      }
    }
    return latest.effectiveTo;
  }

  /** In-app notification (+ email for decisions taken by an admin). */
  private async notify(
    tx: Tx,
    enrollmentId: string,
    userId: string,
    email: string | null,
    programName: string,
    optionName: string,
    notice: Notice,
  ): Promise<void> {
    await this.notifications.notify(tx, {
      userId,
      type: notice.type,
      title: notice.title.slice(0, 200),
      body: notice.body.slice(0, 2000),
      data: { enrollmentId },
      dedupeKey: `${notice.type}:${enrollmentId}`,
    });
    if (email && notice.emailStatus) {
      await this.outbox.enqueue(tx, {
        topic: 'email.send',
        payload: {
          to: email,
          template: 'enrollment-status',
          data: {
            programName,
            optionName,
            status: notice.emailStatus,
            ...(notice.emailStatus === 'REJECTED' || notice.emailStatus === 'CANCELLED' ? { reason: notice.body } : {}),
            url: `${this.config.app.publicUrl}/programs`,
          },
        },
        dedupeKey: `email:${notice.type}:${enrollmentId}`,
      });
    }
  }

  /** Turns DB uniqueness/exclusion races into the friendly domain errors. */
  private mapEnrollmentConflict(err: unknown): unknown {
    if (err instanceof AppError) return err;
    const info = inspectDbError(err);
    if (!info) return err;
    if (info.sqlState === '23505' && info.constraint?.includes('payment_reference')) {
      return conflict('This payment reference has already been used', {
        issues: [{ path: 'paymentReference', message: 'Already used — payment references must be unique', code: 'custom' }],
      });
    }
    if (info.sqlState === '23505' && info.constraint?.includes('one_pending')) {
      return new AppError(ErrorCode.AlreadyEnrolled, 'You already have an enrollment waiting for activation in this program', 409);
    }
    if (info.sqlState === '23P01') {
      return new AppError(ErrorCode.AlreadyEnrolled, 'This coverage period overlaps an existing enrollment', 409);
    }
    return err;
  }
}

