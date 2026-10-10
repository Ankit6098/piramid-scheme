import { Injectable, Logger } from '@nestjs/common';
import {
  ErrorCode,
  REWARD_SOD_CONFLICT_REASON,
  type BulkApproveItemResultDto,
  type BulkApproveResultDto,
  type RewardDecisionResultDto,
  type RewardStatus,
} from '@app/shared';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthContext } from '../../common/auth/auth-context';
import { assertProgramAccess } from '../../common/auth/program-access';
import { AppError, conflict, invalidState, isAppError, notFound } from '../../common/errors/app-error';
import { mapDbError } from '../../common/errors/db-error';
import { PrismaService, type Tx } from '../../common/prisma/prisma.service';
import type { QualifyingEventStatus, RewardUnit } from '../../generated/prisma/client';
import { LedgerService } from '../ledger/ledger.service';
import { findSodViolation, sodMessage, type RewardDecisionKind } from './domain/sod';
import { RewardNotifier } from './reward-notifier';

export interface LockedRewardRow {
  id: string;
  status: RewardStatus;
  recipient_user_id: string;
  program_id: string;
  event_id: string;
  amount_minor: bigint;
  reward_unit: RewardUnit;
  currency_code: string;
}

export interface LockedEventRow {
  id: string;
  status: QualifyingEventStatus;
  program_id: string;
  recorded_by_id: string | null;
}

/** `SELECT … FOR SHARE` on the event: serializes approvals with an event reversal (which UPDATEs it). */
export async function lockEventShared(tx: Tx, eventId: string): Promise<LockedEventRow> {
  const rows = await tx.$queryRaw<LockedEventRow[]>`
    SELECT "id", "status", "program_id", "recorded_by_id"
      FROM "qualifying_events" WHERE "id" = ${eventId}::uuid FOR SHARE`;
  if (!rows[0]) throw notFound('Qualifying event');
  return rows[0];
}

export async function lockRewardForUpdate(tx: Tx, rewardId: string): Promise<LockedRewardRow> {
  const rows = await tx.$queryRaw<LockedRewardRow[]>`
    SELECT "id", "status"::text AS "status", "recipient_user_id", "program_id", "event_id", "amount_minor",
           "reward_unit", "currency_code"
      FROM "rewards" WHERE "id" = ${rewardId}::uuid FOR UPDATE`;
  if (!rows[0]) throw notFound('Reward');
  return rows[0];
}

export function sodConflict(kind: RewardDecisionKind, rule: NonNullable<ReturnType<typeof findSodViolation>>): AppError {
  return conflict(sodMessage(rule, kind), { reason: REWARD_SOD_CONFLICT_REASON, rule });
}

const STATUS_MESSAGES: Record<RewardDecisionKind, Partial<Record<RewardStatus, string>>> = {
  approve: {
    POSTED: 'This reward has already been approved and posted.',
    REJECTED: 'This reward was rejected and can no longer be approved.',
    REVERSED: 'This reward was reversed and can no longer be approved.',
  },
  reject: {
    POSTED: 'This reward has already been posted. Reverse it instead of rejecting it.',
    REJECTED: 'This reward has already been rejected.',
    REVERSED: 'This reward was reversed and can no longer be rejected.',
  },
  reverse: {
    PENDING_APPROVAL: 'Only posted rewards can be reversed. Reject a pending reward instead.',
    APPROVED: 'Only posted rewards can be reversed. Reject an unposted reward instead.',
    REJECTED: 'This reward was rejected, so there is nothing to reverse.',
    REVERSED: 'This reward has already been reversed.',
  },
};

const ALLOWED: Record<RewardDecisionKind, readonly RewardStatus[]> = {
  approve: ['PENDING_APPROVAL', 'APPROVED'],
  reject: ['PENDING_APPROVAL', 'APPROVED'],
  reverse: ['POSTED'],
};

function assertDecidable(kind: RewardDecisionKind, status: RewardStatus, eventStatus: QualifyingEventStatus): void {
  if (!ALLOWED[kind].includes(status)) {
    throw invalidState(STATUS_MESSAGES[kind][status] ?? `The reward is ${status}`, { status });
  }
  if (kind === 'approve' && eventStatus !== 'PROCESSED') {
    throw invalidState('The sale behind this reward was reversed, so the reward can no longer be approved.', {
      status,
      eventStatus,
    });
  }
}

/**
 * Reward decisions (business rules §9): approve = approve + post in one transaction, reject with a
 * reason, bulk approve (one transaction per reward), reverse a posted reward. Lock order in every
 * decision: the event `FOR SHARE` first, then the reward `FOR UPDATE` — the same order an event
 * reversal uses (event row lock → rewards), so the two serialize without deadlocks.
 */
@Injectable()
export class RewardDecisionsService {
  private readonly logger = new Logger(RewardDecisionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly notifier: RewardNotifier,
  ) {}

  async approve(auth: AuthContext, rewardId: string): Promise<RewardDecisionResultDto> {
    const pre = await this.precheck(auth, rewardId, 'approve');
    return this.prisma.runInTransaction(
      async (tx) => {
        const { reward, event } = await this.lockAndCheck(tx, auth, rewardId, pre.eventId, 'approve');
        if (reward.status === 'PENDING_APPROVAL') {
          await tx.reward.update({
            where: { id: rewardId },
            data: { status: 'APPROVED', approvedById: auth.userId, approvedAt: new Date() },
          });
        }
        // LedgerService moves the reward to POSTED together with the two-entry posting.
        const posting = await this.ledger.postReward(tx, rewardId, auth.userId);
        await this.audit.record(tx, {
          action: 'reward.approve',
          resourceType: 'reward',
          resourceId: rewardId,
          programId: reward.program_id,
          before: { status: reward.status },
          after: { status: 'POSTED', approvedById: auth.userId, ledgerTransactionId: posting.transactionId, eventId: event.id },
        });
        await this.notifier.notify(tx, this.notice(reward, 'posted'));
        return {
          id: rewardId,
          status: 'POSTED' as const,
          ledgerTransaction: { id: posting.transactionId, type: 'REWARD_POSTING' as const },
        };
      },
      { retries: 1 },
    );
  }

  async reject(auth: AuthContext, rewardId: string, reason: string): Promise<RewardDecisionResultDto> {
    const pre = await this.precheck(auth, rewardId, 'reject');
    return this.prisma.runInTransaction(
      async (tx) => {
        const { reward } = await this.lockAndCheck(tx, auth, rewardId, pre.eventId, 'reject');
        await tx.reward.update({
          where: { id: rewardId },
          data: { status: 'REJECTED', rejectedById: auth.userId, rejectedAt: new Date(), rejectionReason: reason },
        });
        await this.audit.record(tx, {
          action: 'reward.reject',
          resourceType: 'reward',
          resourceId: rewardId,
          programId: reward.program_id,
          before: { status: reward.status },
          after: { status: 'REJECTED', rejectedById: auth.userId },
          reason,
        });
        await this.notifier.notify(tx, { ...this.notice(reward, 'rejected'), reason });
        return { id: rewardId, status: 'REJECTED' as const, ledgerTransaction: null };
      },
      { retries: 1 },
    );
  }

  async reverse(auth: AuthContext, rewardId: string, reason: string): Promise<RewardDecisionResultDto> {
    const pre = await this.precheck(auth, rewardId, 'reverse');
    return this.prisma.runInTransaction(
      async (tx) => {
        const { reward } = await this.lockAndCheck(tx, auth, rewardId, pre.eventId, 'reverse');
        // LedgerService writes the mirrored transaction and moves the reward to REVERSED.
        const reversal = await this.ledger.reverseReward(tx, rewardId, auth.userId, reason);
        await this.audit.record(tx, {
          action: 'reward.reverse',
          resourceType: 'reward',
          resourceId: rewardId,
          programId: reward.program_id,
          before: { status: reward.status },
          after: { status: 'REVERSED', reversedById: auth.userId, ledgerTransactionId: reversal.transactionId },
          reason,
        });
        await this.notifier.notify(tx, { ...this.notice(reward, 'reversed'), reason });
        return {
          id: rewardId,
          status: 'REVERSED' as const,
          ledgerTransaction: { id: reversal.transactionId, type: 'REWARD_REVERSAL' as const },
        };
      },
      { retries: 1 },
    );
  }

  /** Each reward in its own transaction; failures are reported per item and never stop the batch. */
  async bulkApprove(auth: AuthContext, ids: readonly string[]): Promise<BulkApproveResultDto> {
    const results: BulkApproveItemResultDto[] = [];
    for (const id of ids) {
      try {
        const res = await this.approve(auth, id);
        results.push({ id, ok: true, status: res.status, ledgerTransactionId: res.ledgerTransaction!.id });
      } catch (err) {
        const appErr = isAppError(err) ? err : mapDbError(err);
        if (!appErr) this.logger.error({ err, rewardId: id }, 'bulk approve item failed');
        results.push({
          id,
          ok: false,
          error: appErr
            ? { code: appErr.code, message: appErr.message }
            : { code: ErrorCode.Internal, message: 'Unexpected error while approving this reward' },
        });
      }
    }
    const approved = results.filter((r) => r.ok).length;
    return { results, approved, failed: results.length - approved };
  }

  // ─── helpers ────────────────────────────────────────────────────────────

  /** Friendly checks before any lock: existence, program scope, SoD and the current status. */
  private async precheck(auth: AuthContext, rewardId: string, kind: RewardDecisionKind) {
    const reward = await this.prisma.reward.findUnique({
      where: { id: rewardId },
      select: {
        id: true,
        programId: true,
        eventId: true,
        recipientUserId: true,
        status: true,
        event: { select: { recordedById: true, status: true } },
      },
    });
    if (!reward) throw notFound('Reward');
    assertProgramAccess(auth, reward.programId, 'read');
    const rule = findSodViolation(kind, {
      actorUserId: auth.userId,
      recipientUserId: reward.recipientUserId,
      saleRecordedById: reward.event.recordedById,
    });
    if (rule) throw sodConflict(kind, rule);
    assertDecidable(kind, reward.status, reward.event.status);
    return reward;
  }

  /** Re-checks status and SoD on the locked rows (the event lock is already held). */
  private async lockAndCheck(tx: Tx, auth: AuthContext, rewardId: string, eventId: string, kind: RewardDecisionKind) {
    const event = await lockEventShared(tx, eventId);
    const reward = await lockRewardForUpdate(tx, rewardId);
    const rule = findSodViolation(kind, {
      actorUserId: auth.userId,
      recipientUserId: reward.recipient_user_id,
      saleRecordedById: event.recorded_by_id,
    });
    if (rule) throw sodConflict(kind, rule);
    assertDecidable(kind, reward.status, event.status);
    return { reward, event };
  }

  private notice(reward: LockedRewardRow, kind: 'posted' | 'rejected' | 'reversed') {
    return {
      rewardId: reward.id,
      recipientUserId: reward.recipient_user_id,
      programId: reward.program_id,
      amountMinor: reward.amount_minor,
      rewardUnit: reward.reward_unit,
      currencyCode: reward.currency_code,
      kind,
    };
  }
}
