import { Injectable, Logger } from '@nestjs/common';
import {
  PROGRAM_LIFECYCLE_RULES,
  type AdminProgramDetailDto,
  type ProgramLifecycleAction,
} from '@app/shared';
import {
  assertProgramAccess,
  AuditService,
  inspectDbError,
  invalidState,
  PrismaService,
  SqlState,
  staleVersion,
  withLockTimeout,
  type AuthContext,
  type Tx,
} from '../../common';
import type { Prisma, ProgramStatus } from '../../generated/prisma/client';
import {
  canCancelScheduled,
  computeCancellationEndsAt,
  computeCompletionDates,
  evaluatePublishChecks,
  publishTargetStatus,
} from './domain/program-rules';
import { lockProgram, setStatusReason } from './program-db';
import { ProgramsService } from './programs.service';

const VERB: Record<ProgramLifecycleAction, string> = {
  publish: 'published',
  pause: 'paused',
  resume: 'resumed',
  complete: 'completed',
  archive: 'archived',
  cancel: 'cancelled',
};

export interface ScheduledTransitionResult {
  started: string[];
  completed: string[];
  failed: string[];
  /** Row lock not obtained within SCHEDULER_LOCK_TIMEOUT_MS (busy); retried on the next run. */
  busy: string[];
}

/**
 * Longest wait of the scheduler for a program row lock. Enrollments hold the row FOR SHARE only
 * briefly; a blocking FOR UPDATE queues ahead of new share-lockers, so the transition happens on this
 * run instead of being skipped while members keep enrolling (SKIP LOCKED skipped it every time).
 */
export const SCHEDULER_LOCK_TIMEOUT_MS = 2_000;

/**
 * Program lifecycle (business rules §4, DB state machine `trg_programs_guard`): manual publish /
 * pause / resume / complete / archive / cancel (SCHEDULED → ARCHIVED before the start), and the
 * scheduler's SCHEDULED → ACTIVE (at `startsAt`) and ACTIVE|PAUSED → COMPLETED (at `endsAt`).
 * Every change is logged by trigger in
 * `program_status_changes` with the actor (`updated_by_id`, null = system) and the reason
 * (`app.status_reason`), and audited in the same transaction.
 */
@Injectable()
export class ProgramLifecycleService {
  private readonly logger = new Logger(ProgramLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly programs: ProgramsService,
    private readonly audit: AuditService,
  ) {}

  async transition(
    auth: AuthContext,
    id: string,
    action: ProgramLifecycleAction,
    input: { expectedVersion?: number; reason?: string },
  ): Promise<AdminProgramDetailDto> {
    assertProgramAccess(auth, id, 'write');
    const rule = PROGRAM_LIFECYCLE_RULES[action];
    if (rule.reasonRequired && !input.reason) {
      throw invalidState(`A reason is required to ${action} a program`);
    }
    return this.prisma.runInTransaction(async (tx) => {
      await lockProgram(tx, id);
      const p = await tx.program.findUniqueOrThrow({
        where: { id },
        include: { offering: { select: { status: true } }, _count: { select: { options: { where: { isActive: true } } } } },
      });
      if (input.expectedVersion !== undefined && p.version !== input.expectedVersion) throw staleVersion();
      if (!rule.from.includes(p.status)) {
        throw invalidState(`A ${p.status.toLowerCase()} program can't be ${VERB[action]}`, { status: p.status, action });
      }
      const now = new Date();
      const data: Prisma.ProgramUncheckedUpdateInput = { updatedById: auth.userId };
      let to: ProgramStatus = p.status;

      switch (action) {
        case 'publish': {
          const publishedPolicyCount = await tx.rewardPolicyVersion.count({ where: { programId: id, status: 'PUBLISHED' } });
          const checks = evaluatePublishChecks(
            {
              startsAt: p.startsAt,
              endsAt: p.endsAt,
              enrollmentOpensAt: p.enrollmentOpensAt,
              enrollmentClosesAt: p.enrollmentClosesAt,
              activeOptionCount: p._count.options,
              offeringStatus: p.offering.status,
              publishedPolicyCount,
            },
            now,
          );
          const failing = checks.filter((c) => !c.ok);
          if (failing.length > 0) {
            throw invalidState(`The program is not ready to publish: ${failing.map((c) => c.message).join('; ')}`, {
              checks: failing,
            });
          }
          to = publishTargetStatus(p.startsAt, now);
          data.publishedAt = now;
          break;
        }
        case 'pause':
          to = 'PAUSED';
          break;
        case 'resume':
          if (p.endsAt && p.endsAt.getTime() <= now.getTime()) {
            throw invalidState('The program has reached its end date; complete it instead of resuming');
          }
          to = 'ACTIVE';
          break;
        case 'complete':
          to = 'COMPLETED';
          Object.assign(data, computeCompletionDates(p, now));
          break;
        case 'archive':
          to = 'ARCHIVED';
          break;
        case 'cancel': {
          // Withdraw a published program that never started: no enrollments or sales can exist yet.
          if (!canCancelScheduled(p, now)) {
            throw invalidState('The start date has passed and the program is starting; pause or complete it instead', {
              status: p.status,
              action,
            });
          }
          to = 'ARCHIVED';
          const endsAt = computeCancellationEndsAt(p);
          if (endsAt) data.endsAt = endsAt;
          break;
        }
      }
      data.status = to;

      await setStatusReason(tx, input.reason);
      await tx.program.update({ where: { id }, data });
      await this.audit.record(tx, {
        action: `program.${action}`,
        resourceType: 'program',
        resourceId: id,
        programId: id,
        before: {
          status: p.status,
          ...(data.endsAt ? { endsAt: p.endsAt?.toISOString() ?? null } : {}),
          ...(data.enrollmentClosesAt ? { enrollmentClosesAt: p.enrollmentClosesAt?.toISOString() ?? null } : {}),
        },
        after: {
          status: to,
          ...(data.endsAt ? { endsAt: (data.endsAt as Date).toISOString() } : {}),
          ...(data.enrollmentClosesAt ? { enrollmentClosesAt: (data.enrollmentClosesAt as Date).toISOString() } : {}),
          ...(data.enrollmentOpensAt ? { enrollmentOpensAt: (data.enrollmentOpensAt as Date).toISOString() } : {}),
        },
        reason: input.reason ?? null,
      });
      return this.programs.loadDetail(tx, id, now);
    });
  }

  /**
   * Scheduler job `programs-status-transitions` (idempotent): starts SCHEDULED programs whose
   * `startsAt` has passed and completes ACTIVE/PAUSED programs whose `endsAt` has passed. Each
   * program changes in its own transaction (blocking row lock, at most SCHEDULER_LOCK_TIMEOUT_MS).
   * The change is recorded at the instant it was due (`startsAt` / `endsAt`, see
   * `trg_programs_log_status`), so a late run never leaves sales after the start without an ACTIVE
   * status. Busy rows and failures are logged and retried on the next run.
   */
  async applyScheduledTransitions(now = new Date()): Promise<ScheduledTransitionResult> {
    const result: ScheduledTransitionResult = { started: [], completed: [], failed: [], busy: [] };

    const due = await this.prisma.program.findMany({
      where: { status: 'SCHEDULED', startsAt: { lte: now } },
      select: { id: true },
      orderBy: { startsAt: 'asc' },
      take: 500,
    });
    for (const { id } of due) {
      try {
        const done = await this.prisma.runInTransaction((tx) =>
          this.autoTransition(tx, id, ['SCHEDULED'], 'ACTIVE', 'startsAt', 'Start date reached', 'program.auto_start', now),
        );
        if (done) result.started.push(id);
      } catch (err) {
        this.recordFailure(result, id, err, 'start');
      }
    }

    const ending = await this.prisma.program.findMany({
      where: { status: { in: ['ACTIVE', 'PAUSED'] }, endsAt: { lte: now } },
      select: { id: true },
      orderBy: { endsAt: 'asc' },
      take: 500,
    });
    for (const { id } of ending) {
      try {
        const done = await this.prisma.runInTransaction((tx) =>
          this.autoTransition(tx, id, ['ACTIVE', 'PAUSED'], 'COMPLETED', 'endsAt', 'End date reached', 'program.auto_complete', now),
        );
        if (done) result.completed.push(id);
      } catch (err) {
        this.recordFailure(result, id, err, 'completion');
      }
    }
    if (result.started.length || result.completed.length) {
      this.logger.log({ started: result.started.length, completed: result.completed.length }, 'program status transitions applied');
    }
    return result;
  }

  private recordFailure(result: ScheduledTransitionResult, programId: string, err: unknown, kind: 'start' | 'completion'): void {
    if (inspectDbError(err)?.sqlState === SqlState.LockNotAvailable) {
      result.busy.push(programId);
      this.logger.warn({ programId }, `scheduled program ${kind} skipped: the program row stayed locked; retrying on the next run`);
      return;
    }
    result.failed.push(programId);
    this.logger.error({ err, programId }, `scheduled program ${kind} failed`);
  }

  private async autoTransition(
    tx: Tx,
    id: string,
    from: ProgramStatus[],
    to: ProgramStatus,
    dateField: 'startsAt' | 'endsAt',
    reason: string,
    action: string,
    now: Date,
  ): Promise<boolean> {
    // Blocking lock with a short timeout (55P03 → reported as busy): SKIP LOCKED silently skipped
    // programs whose row members kept share-locking by enrolling.
    const rows = await withLockTimeout(tx, SCHEDULER_LOCK_TIMEOUT_MS, () =>
      tx.$queryRaw<Array<{ status: ProgramStatus; starts_at: Date; ends_at: Date | null }>>`
        SELECT "status", "starts_at", "ends_at" FROM "programs" WHERE "id" = ${id}::uuid FOR UPDATE`,
    );
    const row = rows[0];
    if (!row || !from.includes(row.status)) return false;
    const at = dateField === 'startsAt' ? row.starts_at : row.ends_at;
    if (!at || at.getTime() > now.getTime()) return false;
    await setStatusReason(tx, reason);
    // Logged at the instant the transition was due (clamped in SQL to ≤ now and ≥ the previous change).
    await tx.$executeRaw`SELECT set_config('app.status_changed_at', ${at.toISOString()}, true)`;
    await tx.program.update({ where: { id }, data: { status: to, updatedById: null } });
    await this.audit.record(tx, {
      action,
      resourceType: 'program',
      resourceId: id,
      programId: id,
      actorUserId: null,
      before: { status: row.status },
      after: { status: to },
      reason,
    });
    return true;
  }
}
