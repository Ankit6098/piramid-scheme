import { Injectable } from '@nestjs/common';
import { REWARD_SOD_CONFLICT_REASON, RewardSodRule, type EventReversalResultDto } from '@app/shared';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthContext } from '../../common/auth/auth-context';
import { assertProgramAccess } from '../../common/auth/program-access';
import { conflict, invalidState, notFound } from '../../common/errors/app-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { QualifyingEventStatus } from '../../generated/prisma/client';
import { LedgerService } from '../ledger/ledger.service';
import type { LockedRewardRow } from './reward-decisions.service';
import { RewardNotifier } from './reward-notifier';

const LIVE = new Set(['PENDING_APPROVAL', 'APPROVED', 'POSTED']);

const NOT_REVERSIBLE: Record<Exclude<QualifyingEventStatus, 'PROCESSED'>, string> = {
  REVERSED: 'This sale has already been reversed.',
  RECEIVED: 'This sale has not been processed yet. Wait until processing finishes, then reverse it.',
  REJECTED: 'This sale was rejected, so there is nothing to reverse.',
};

function notReversible(status: QualifyingEventStatus) {
  return invalidState(NOT_REVERSIBLE[status as Exclude<QualifyingEventStatus, 'PROCESSED'>] ?? `The sale is ${status}`, {
    status,
  });
}

function ownRewardConflict() {
  return conflict(
    'You received a reward from this sale, so you cannot reverse it. Another reviewer must reverse this sale.',
    { reason: REWARD_SOD_CONFLICT_REASON, rule: RewardSodRule.OwnReward },
  );
}

/** Rejection / reversal reason stored on each affected reward (≤ 500 chars). */
export function saleReversedReason(reason: string): string {
  return `Sale reversed: ${reason}`.slice(0, 500);
}

/**
 * Event reversal — refund / chargeback of a processed sale (business rules §9). One transaction:
 * UPDATE the event to REVERSED first (row lock; approvals hold the event FOR SHARE, so they finish
 * first or wait and then fail), then every reward of the sale: PENDING_APPROVAL / APPROVED →
 * REJECTED ("Sale reversed: …"), POSTED → REVERSED with a compensating ledger transaction. The DB
 * refuses a commit that leaves live rewards on a reversed event.
 */
@Injectable()
export class EventReversalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly notifier: RewardNotifier,
  ) {}

  async reverse(auth: AuthContext, eventId: string, reason: string): Promise<EventReversalResultDto> {
    const event = await this.prisma.qualifyingEvent.findUnique({
      where: { id: eventId },
      select: { id: true, programId: true, status: true, rewards: { select: { recipientUserId: true, status: true } } },
    });
    if (!event) throw notFound('Qualifying event');
    assertProgramAccess(auth, event.programId, 'read');
    if (event.status !== 'PROCESSED') throw notReversible(event.status);
    if (event.rewards.some((r) => LIVE.has(r.status) && r.recipientUserId === auth.userId)) throw ownRewardConflict();

    const rewardReason = saleReversedReason(reason);
    return this.prisma.runInTransaction(
      async (tx) => {
        const reversedAt = new Date();
        // 1) The event first: this UPDATE takes its row lock (conflicts with approvals' FOR SHARE).
        const updated = await tx.qualifyingEvent.updateMany({
          where: { id: eventId, status: 'PROCESSED' },
          data: { status: 'REVERSED', reversedAt, reversalReason: reason.slice(0, 500) },
        });
        if (updated.count !== 1) {
          const current = await tx.qualifyingEvent.findUniqueOrThrow({ where: { id: eventId }, select: { status: true } });
          throw notReversible(current.status);
        }

        // 2) Then its rewards — read after the lock so concurrent approvals are visible.
        const rewards = await tx.$queryRaw<LockedRewardRow[]>`
          SELECT "id", "status"::text AS "status", "recipient_user_id", "program_id", "event_id", "amount_minor",
                 "reward_unit", "currency_code"
            FROM "rewards" WHERE "event_id" = ${eventId}::uuid
           ORDER BY "level" ASC
             FOR UPDATE`;
        if (rewards.some((r) => LIVE.has(r.status) && r.recipient_user_id === auth.userId)) throw ownRewardConflict();

        const rejectedRewardIds: string[] = [];
        const reversedRewardIds: string[] = [];
        for (const r of rewards) {
          const notice = {
            rewardId: r.id,
            recipientUserId: r.recipient_user_id,
            programId: r.program_id,
            amountMinor: r.amount_minor,
            rewardUnit: r.reward_unit,
            currencyCode: r.currency_code,
            reason,
            saleReversed: true,
          };
          if (r.status === 'PENDING_APPROVAL' || r.status === 'APPROVED') {
            await tx.reward.update({
              where: { id: r.id },
              data: { status: 'REJECTED', rejectedById: auth.userId, rejectedAt: reversedAt, rejectionReason: rewardReason },
            });
            await this.audit.record(tx, {
              action: 'reward.reject',
              resourceType: 'reward',
              resourceId: r.id,
              programId: r.program_id,
              before: { status: r.status },
              after: { status: 'REJECTED', rejectedById: auth.userId, cause: 'event.reverse', eventId },
              reason: rewardReason,
            });
            await this.notifier.notify(tx, { ...notice, kind: 'rejected' });
            rejectedRewardIds.push(r.id);
          } else if (r.status === 'POSTED') {
            const reversal = await this.ledger.reverseReward(tx, r.id, auth.userId, rewardReason);
            await this.audit.record(tx, {
              action: 'reward.reverse',
              resourceType: 'reward',
              resourceId: r.id,
              programId: r.program_id,
              before: { status: r.status },
              after: {
                status: 'REVERSED',
                reversedById: auth.userId,
                ledgerTransactionId: reversal.transactionId,
                cause: 'event.reverse',
                eventId,
              },
              reason: rewardReason,
            });
            await this.notifier.notify(tx, { ...notice, kind: 'reversed' });
            reversedRewardIds.push(r.id);
          }
        }

        await this.audit.record(tx, {
          action: 'event.reverse',
          resourceType: 'qualifying_event',
          resourceId: eventId,
          programId: event.programId,
          before: { status: 'PROCESSED' },
          after: { status: 'REVERSED', rejectedRewards: rejectedRewardIds.length, reversedRewards: reversedRewardIds.length },
          reason,
        });
        return {
          eventId,
          status: 'REVERSED' as const,
          reversedAt: reversedAt.toISOString(),
          rejectedRewardIds,
          reversedRewardIds,
        };
      },
      { timeout: 30_000, retries: 1 },
    );
  }
}
