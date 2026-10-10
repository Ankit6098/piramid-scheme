import type { RewardSummaryBucketDto, RewardUnit } from '@app/shared';
import type { Db } from '../../common';
import { Prisma } from '../../generated/prisma/client';
import { mergeRewardSummary, type RewardSummaryBucket } from './domain/admin-rules';

/** Program filter: every program, or only rewards of these programs. */
export type ProgramScope = 'ALL' | readonly string[];

/**
 * Reward totals of one member per (unit, currency) — business rules §10:
 * earned = Σ CREDIT − Σ DEBIT on the member's MEMBER_REWARDS_PAYABLE accounts (from the ledger),
 * pending = Σ PENDING_APPROVAL + APPROVED, reversed = Σ REVERSED. With a program scope, ledger
 * entries are attributed through their transaction's reward.
 */
export async function loadRewardSummary(db: Db, userId: string, scope: ProgramScope): Promise<RewardSummaryBucket[]> {
  if (scope !== 'ALL' && scope.length === 0) return [];
  const scoped = scope !== 'ALL';
  const programIds = scoped ? [...scope] : [];
  const [ledger, rewards] = await Promise.all([
    db.$queryRaw<Array<{ rewardUnit: RewardUnit; currencyCode: string; balanceMinor: bigint }>>`
      SELECT le."reward_unit"::text AS "rewardUnit", le."currency_code" AS "currencyCode",
             COALESCE(SUM(CASE WHEN le."direction" = 'CREDIT' THEN le."amount_minor" ELSE -le."amount_minor" END), 0)::bigint AS "balanceMinor"
      FROM "ledger_entries" le
      JOIN "ledger_accounts" la ON la."id" = le."account_id"
      ${scoped ? Prisma.sql`JOIN "ledger_transactions" lt ON lt."id" = le."transaction_id" JOIN "rewards" r ON r."id" = lt."reward_id"` : Prisma.empty}
      WHERE la."type" = 'MEMBER_REWARDS_PAYABLE' AND la."user_id" = ${userId}::uuid
      ${scoped ? Prisma.sql`AND r."program_id" = ANY(${programIds}::uuid[])` : Prisma.empty}
      GROUP BY le."reward_unit", le."currency_code"`,
    db.reward.groupBy({
      by: ['rewardUnit', 'currencyCode', 'status'],
      where: {
        recipientUserId: userId,
        status: { in: ['PENDING_APPROVAL', 'APPROVED', 'REVERSED'] },
        ...(scoped ? { programId: { in: programIds } } : {}),
      },
      _sum: { amountMinor: true },
    }),
  ]);
  return mergeRewardSummary(
    ledger.map((r) => ({ rewardUnit: r.rewardUnit, currencyCode: r.currencyCode.trim(), balanceMinor: BigInt(r.balanceMinor) })),
    rewards.map((r) => ({
      rewardUnit: r.rewardUnit,
      currencyCode: r.currencyCode.trim(),
      status: r.status,
      amountMinor: r._sum.amountMinor ?? 0n,
    })),
  );
}

export function toRewardSummaryDto(b: RewardSummaryBucket): RewardSummaryBucketDto {
  return {
    rewardUnit: b.rewardUnit,
    currencyCode: b.currencyCode,
    earnedMinor: b.earnedMinor.toString(),
    pendingMinor: b.pendingMinor.toString(),
    reversedMinor: b.reversedMinor.toString(),
  };
}
