import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  ErrorCode,
  type ProgramStatus,
  type QualifyingEventStatus,
  type QualifyingEventType,
  type RewardUnit,
} from '@app/shared';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthContext } from '../../common/auth/auth-context';
import { assertProgramAccess, canAccessProgram } from '../../common/auth/program-access';
import { AppError, conflict, forbidden, invalidState, notFound, validationFailed } from '../../common/errors/app-error';
import { inspectDbError, SqlState } from '../../common/errors/db-error';
import { PrismaService, type Tx } from '../../common/prisma/prisma.service';
import { RewardEngineService } from '../rewards/reward-engine.service';
import type { CalcPolicy } from '../rewards/domain/reward-calculator';
import type { PlanPaymentMatch } from '../rewards/domain/plan-payment';
import { STATUS_CHANGES_LOOKBACK, statusInForce } from '../rewards/domain/program-status';
import { PlanPaymentLookalikeService } from '../rewards/plan-payment-lookalike.service';
import {
  decideRevision,
  evaluateIntake,
  saleRequestHash,
  type IntakeRejection,
  type RevisionDecision,
} from './domain/intake';

/** Who is recording the sale. */
export type IntakeActor =
  | { kind: 'ADMIN'; auth: AuthContext }
  | { kind: 'API_CLIENT'; clientId: string; programId: string };

export interface SaleIntakeRequest {
  programId: string;
  type: QualifyingEventType;
  externalId: string;
  customerReference: string;
  subjectUserId: string;
  amountMinor: string;
  currencyCode?: string | undefined;
  occurredAt: string;
  description?: string | undefined;
  supersedesEventId?: string | undefined;
}

export interface SaleIntakeResult {
  eventId: string;
  replayed: boolean;
}

interface IntakeProgram {
  id: string;
  offeringId: string;
  status: ProgramStatus;
  startsAt: Date;
  endsAt: Date | null;
  lateEventGraceDays: number;
  currencyCode: string;
  rewardUnit: RewardUnit;
  currencyMinorUnits: number;
}

const NOT_REJECTABLE: Record<Exclude<QualifyingEventStatus, 'RECEIVED'>, string> = {
  PROCESSED: 'This sale has already been processed. Reverse it instead of rejecting it.',
  REJECTED: 'This sale has already been rejected.',
  REVERSED: 'This sale was reversed, so it can no longer be rejected.',
};

function notRejectable(status: QualifyingEventStatus): AppError {
  return invalidState(NOT_REJECTABLE[status as Exclude<QualifyingEventStatus, 'RECEIVED'>] ?? `The sale is ${status}`, { status });
}

/** Events stuck in RECEIVED longer than this are picked up by the sweeper. */
export const STUCK_EVENT_AGE_MS = 2 * 60_000;
const SWEEP_BATCH = 100;
const MAX_INSERT_ATTEMPTS = 3;

/**
 * Sales intake (business rules §8): authorization, idempotent replay / revision handling keyed by
 * (offering, externalId, revision), intake validation (failures stored as REJECTED with a reason when
 * the row itself is valid), then the reward engine after commit. The DB re-checks every rule; the
 * pre-checks here exist to return friendly errors instead of raw invariant violations.
 */
@Injectable()
export class EventIntakeService {
  private readonly logger = new Logger(EventIntakeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: RewardEngineService,
    private readonly lookalike: PlanPaymentLookalikeService,
  ) {}

  /** Records (or replays) a sale and runs the engine for a new RECEIVED event. */
  async record(actor: IntakeActor, req: SaleIntakeRequest): Promise<SaleIntakeResult> {
    if (actor.kind === 'ADMIN') {
      assertProgramAccess(actor.auth, req.programId, 'write');
    } else if (req.programId !== actor.programId) {
      throw forbidden('This API key is not authorized for that program');
    }

    const program = await this.prisma.program.findUnique({
      where: { id: req.programId },
      select: {
        id: true,
        offeringId: true,
        status: true,
        startsAt: true,
        endsAt: true,
        lateEventGraceDays: true,
        currencyCode: true,
        rewardUnit: true,
        currencyMinorUnits: true,
      },
    });
    if (!program) throw notFound('Program');
    if (req.currencyCode !== undefined && req.currencyCode !== program.currencyCode) {
      throw validationFailed(`Sales in this program are recorded in ${program.currencyCode}`, {
        issues: [{ path: 'currencyCode', message: `Must be ${program.currencyCode}`, code: 'custom' }],
      });
    }
    const subject = await this.prisma.user.findUnique({ where: { id: req.subjectUserId }, select: { id: true } });
    if (!subject) {
      throw validationFailed('No member exists with this id', {
        issues: [{ path: 'subjectUserId', message: 'Unknown member', code: 'custom' }],
      });
    }
    if (actor.kind === 'ADMIN') await this.assertRecorderSod(actor.auth.userId, subject.id);

    const occurredAt = new Date(req.occurredAt);
    const amountMinor = BigInt(req.amountMinor);
    const requestHash = saleRequestHash({
      programId: program.id,
      type: req.type,
      externalId: req.externalId,
      customerReference: req.customerReference,
      subjectUserId: subject.id,
      amountMinor,
      currencyCode: program.currencyCode,
      occurredAt,
      supersedesEventId: req.supersedesEventId ?? null,
    });

    for (let attempt = 1; ; attempt++) {
      const decision = await this.decide(actor, program.offeringId, req.externalId, requestHash, req.supersedesEventId ?? null);
      if (decision.kind === 'replay') return { eventId: decision.eventId, replayed: true };
      if (decision.kind === 'conflict') throw this.conflictError(decision.code);
      try {
        const created = await this.insert(actor, program, req, { occurredAt, amountMinor, requestHash, decision });
        if (created.status === 'RECEIVED') await this.processSafely(created.id);
        return { eventId: created.id, replayed: false };
      } catch (err) {
        // A concurrent request recorded the same sale (or revision) first: decide again.
        if (this.isUniqueViolation(err) && attempt < MAX_INSERT_ATTEMPTS) continue;
        if (this.isUniqueViolation(err)) throw conflict('This sale is being recorded by another request. Retry shortly', { retryable: true });
        throw err;
      }
    }
  }

  /** Runs the engine; failures leave the event RECEIVED for the sweeper (never fail the intake). */
  async processSafely(eventId: string): Promise<void> {
    try {
      await this.engine.processEvent(eventId);
    } catch (err) {
      this.logger.warn({ eventId, err: err instanceof Error ? err.message : String(err) }, 'reward engine failed; the sweeper will retry');
    }
  }

  /** Processes events stuck in RECEIVED (engine crash, deploy, transient DB error). Idempotent. */
  async sweepStuck(opts: { olderThanMs?: number; limit?: number; now?: Date } = {}): Promise<{ attempted: number; processed: number }> {
    const cutoff = new Date((opts.now ?? new Date()).getTime() - (opts.olderThanMs ?? STUCK_EVENT_AGE_MS));
    const stuck = await this.prisma.qualifyingEvent.findMany({
      where: { status: 'RECEIVED', createdAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: opts.limit ?? SWEEP_BATCH,
    });
    let processed = 0;
    for (const { id } of stuck) {
      try {
        const result = await this.engine.processEvent(id);
        if (result.outcome !== 'ALREADY_PROCESSED') processed += 1;
      } catch (err) {
        this.logger.error({ eventId: id, err: err instanceof Error ? err.message : String(err) }, 'stuck event still failing');
      }
    }
    if (stuck.length) this.logger.log({ attempted: stuck.length, processed }, 'swept stuck sale events');
    return { attempted: stuck.length, processed };
  }

  /**
   * Rejects a sale that is still RECEIVED — typically one stuck because it can never be processed —
   * so its external id can be re-recorded as a new revision (business rules §8). `events:reverse`,
   * program-scoped, reason required, audited `event.reject`. Serializes with the reward engine on the
   * event row lock: whichever commits first wins; the other sees a non-RECEIVED sale.
   */
  async rejectPending(auth: AuthContext, eventId: string, reason: string): Promise<void> {
    const event = await this.prisma.qualifyingEvent.findUnique({
      where: { id: eventId },
      select: { id: true, programId: true, status: true },
    });
    if (!event) throw notFound('Sale event');
    assertProgramAccess(auth, event.programId, 'read');
    if (event.status !== 'RECEIVED') throw notRejectable(event.status);
    await this.prisma.runInTransaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: QualifyingEventStatus }>>`
        SELECT "status"::text AS "status" FROM "qualifying_events" WHERE "id" = ${eventId}::uuid FOR UPDATE`;
      const status = rows[0]?.status;
      if (status !== 'RECEIVED') throw notRejectable(status ?? 'REJECTED');
      await tx.qualifyingEvent.update({
        where: { id: eventId },
        data: { status: 'REJECTED', rejectionReason: `Rejected by an administrator: ${reason}`.slice(0, 500) },
      });
      await this.audit.record(tx, {
        action: 'event.reject',
        resourceType: 'qualifying_event',
        resourceId: eventId,
        programId: event.programId,
        before: { status: 'RECEIVED' },
        after: { status: 'REJECTED' },
        reason,
      });
    });
  }

  // ─── internals ─────────────────────────────────────────────────────────

  private async assertRecorderSod(recorderId: string, subjectId: string): Promise<void> {
    const path = await this.prisma.referralPath.findUnique({
      where: { ancestorId_descendantId: { ancestorId: recorderId, descendantId: subjectId } },
      select: { depth: true },
    });
    if (!path) return;
    throw new AppError(
      ErrorCode.Conflict,
      path.depth === 0
        ? 'You cannot record a sale credited to yourself. Ask another administrator to record it'
        : 'You cannot record a sale for a member of your own downline. Ask another administrator to record it',
      409,
      { reason: 'RECORDER_SOD' },
    );
  }

  private async decide(
    actor: IntakeActor,
    offeringId: string,
    externalId: string,
    requestHash: string,
    supersedesEventId: string | null,
  ): Promise<RevisionDecision> {
    const revisions = await this.prisma.qualifyingEvent.findMany({
      where: { offeringId, externalId },
      select: { id: true, revision: true, status: true, requestHash: true, programId: true },
      orderBy: { revision: 'asc' },
    });
    return decideRevision(
      revisions.map((r) => ({ ...r, visible: this.canSee(actor, r.programId) })),
      requestHash,
      supersedesEventId,
    );
  }

  private canSee(actor: IntakeActor, programId: string): boolean {
    return actor.kind === 'ADMIN' ? canAccessProgram(actor.auth, programId, 'read') : actor.programId === programId;
  }

  private conflictError(code: Extract<RevisionDecision, { kind: 'conflict' }>['code']): AppError {
    switch (code) {
      case 'IDEMPOTENCY':
        return new AppError(
          ErrorCode.IdempotencyConflict,
          'A sale with this external id was already recorded with different details',
          409,
        );
      case 'STALE_SUPERSEDE':
        return conflict('A newer record of this sale exists. Reload it before re-recording', { reason: 'STALE_SUPERSEDE' });
      case 'NOT_SUPERSEDABLE':
        return invalidState('Only rejected or reversed sales can be re-recorded');
      case 'NOTHING_TO_SUPERSEDE':
        return validationFailed('There is no earlier record of this sale to supersede', {
          issues: [{ path: 'supersedesEventId', message: 'Unknown sale record', code: 'custom' }],
        });
    }
  }

  private async insert(
    actor: IntakeActor,
    program: IntakeProgram,
    req: SaleIntakeRequest,
    ctx: { occurredAt: Date; amountMinor: bigint; requestHash: string; decision: Extract<RevisionDecision, { kind: 'create' }> },
  ): Promise<{ id: string; status: 'RECEIVED' | 'REJECTED' }> {
    return this.prisma.runInTransaction(async (tx) => {
      const { rejection, lookalikes } = await this.evaluate(tx, program, req, ctx.occurredAt, ctx.amountMinor);
      const id = randomUUID();
      const status = rejection ? ('REJECTED' as const) : ('RECEIVED' as const);
      const source = actor.kind === 'ADMIN' ? ('ADMIN_MANUAL' as const) : ('API' as const);
      await tx.qualifyingEvent.create({
        data: {
          id,
          programId: program.id,
          offeringId: program.offeringId,
          type: req.type,
          source,
          externalId: req.externalId,
          revision: ctx.decision.revision,
          supersedesEventId: ctx.decision.supersedesEventId,
          requestHash: ctx.requestHash,
          customerReference: req.customerReference,
          subjectUserId: req.subjectUserId,
          amountMinor: ctx.amountMinor,
          currencyCode: program.currencyCode,
          occurredAt: ctx.occurredAt,
          status,
          rejectionReason: rejection?.reason ?? null,
          description: req.description ? req.description : null,
          recordedById: actor.kind === 'ADMIN' ? actor.auth.userId : null,
          apiClientId: actor.kind === 'API_CLIENT' ? actor.clientId : null,
        },
      });
      await this.audit.record(tx, {
        action: 'event.record',
        resourceType: 'qualifying_event',
        resourceId: id,
        programId: program.id,
        ...(actor.kind === 'API_CLIENT' ? { actorUserId: null, actorRoles: ['API_CLIENT'] } : {}),
        after: {
          source,
          type: req.type,
          externalId: req.externalId,
          revision: ctx.decision.revision,
          supersedesEventId: ctx.decision.supersedesEventId,
          subjectUserId: req.subjectUserId,
          amountMinor: ctx.amountMinor,
          currencyCode: program.currencyCode,
          occurredAt: ctx.occurredAt,
          status,
          rejectionCode: rejection?.code ?? null,
          rejectionReason: rejection?.reason ?? null,
          apiClientId: actor.kind === 'API_CLIENT' ? actor.clientId : null,
          planPaymentLookalike: rejection ? null : lookalikes.length > 0,
        },
      });
      // A downline plan payment of the same amount: processed, but flagged and never auto-approved.
      if (!rejection && lookalikes.length > 0) {
        await this.lookalike.raiseFlag(
          tx,
          {
            eventId: id,
            programId: program.id,
            externalId: req.externalId,
            subjectUserId: req.subjectUserId,
            amountMinor: ctx.amountMinor,
            currencyCode: program.currencyCode,
          },
          lookalikes,
        );
      }
      return { id, status };
    });
  }

  /**
   * Gathers the facts for `evaluateIntake` inside the recording transaction. Also returns the plan
   * payments the sale resembles (business rules §0.1): the subject's own → rejection; a downline
   * member's → the sale is accepted but flagged.
   */
  private async evaluate(
    tx: Tx,
    program: IntakeProgram,
    req: SaleIntakeRequest,
    occurredAt: Date,
    amountMinor: bigint,
  ): Promise<{ rejection: IntakeRejection | null; lookalikes: PlanPaymentMatch[] }> {
    const now = new Date();
    // Sequential: an interactive transaction owns a single connection.
    const offering = await tx.offering.findUnique({ where: { id: program.offeringId }, select: { status: true } });
    const statusChanges = await tx.programStatusChange.findMany({
      where: { programId: program.id, changedAt: { lte: occurredAt } },
      orderBy: { changedAt: 'desc' },
      select: { fromStatus: true, toStatus: true, changedAt: true },
      take: STATUS_CHANGES_LOOKBACK,
    });
    const subject = await tx.user.findUniqueOrThrow({ where: { id: req.subjectUserId }, select: { status: true, emailVerifiedAt: true } });
    // Payment references are unique across programs: any program's plan payment id is not a sale.
    const paymentRef = await tx.programEnrollment.count({ where: { paymentReference: req.externalId } });
    // Same amount in any program with this currency, within ±2 days of the sale date or of now
    // (back-dating cannot escape the window); own payment (depth 0) or a downline member's.
    const lookalikes = await this.lookalike.find(tx, {
      subjectUserId: req.subjectUserId,
      amountMinor,
      currencyCode: program.currencyCode,
      occurredAt,
      recordedAt: now,
    });
    const ownPayment = lookalikes.some((m) => m.depth === 0);
    const policyRow = await tx.rewardPolicyVersion.findFirst({
      where: {
        programId: program.id,
        status: { in: ['PUBLISHED', 'RETIRED'] },
        effectiveFrom: { lte: occurredAt },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: occurredAt } }],
      },
      include: { rules: true },
    });
    const policy: CalcPolicy | null = policyRow
      ? {
          id: policyRow.id,
          version: policyRow.version,
          maxDepth: policyRow.maxDepth,
          budgetBps: policyRow.budgetBps,
          maxTotalPerEventMinor: policyRow.maxTotalPerEventMinor,
          minEventAmountMinor: policyRow.minEventAmountMinor,
          ineligibleAncestorBehavior: policyRow.ineligibleAncestorBehavior,
          roundingMode: policyRow.roundingMode,
          triggerEventTypes: policyRow.triggerEventTypes,
          rules: policyRow.rules,
        }
      : null;
    const rejection = evaluateIntake({
      now,
      type: req.type,
      amountMinor,
      occurredAt,
      offeringActive: offering?.status === 'ACTIVE',
      program,
      statusAtSale: statusInForce(statusChanges),
      subject: { status: subject.status, emailVerified: subject.emailVerifiedAt !== null },
      planPayment: paymentRef > 0 ? 'REFERENCE' : ownPayment ? 'AMOUNT' : null,
      policy,
      unit: policyRow
        ? {
            rewardUnit: program.rewardUnit,
            currencyMinorUnits: program.currencyMinorUnits,
            pointsPerCurrencyUnit: policyRow.pointsPerCurrencyUnit,
          }
        : null,
    });
    return { rejection, lookalikes };
  }

  private isUniqueViolation(err: unknown): boolean {
    const info = inspectDbError(err);
    if (!info) return false;
    return info.sqlState === SqlState.UniqueViolation || (info.prismaCode === 'P2002' && info.sqlState === null);
  }
}
