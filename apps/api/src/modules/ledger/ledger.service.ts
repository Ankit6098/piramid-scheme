import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ErrorCode } from '@app/shared';
import { AppError, notFound } from '../../common/errors/app-error';
import type { Tx } from '../../common/prisma/prisma.service';
import type { LedgerAccountType, RewardUnit } from '../../generated/prisma/client';

export interface LedgerPostingResult {
  transactionId: string;
  /** False when the transaction already existed (idempotent replay). */
  created: boolean;
}

interface LockedReward {
  id: string;
  status: string;
  recipient_user_id: string;
  amount_minor: bigint;
  reward_unit: RewardUnit;
  currency_code: string;
}

export const postingKey = (rewardId: string) => `reward-posting:${rewardId}`;
export const reversalKey = (rewardId: string) => `reward-reversal:${rewardId}`;

/**
 * CROSS-MODULE CONTRACT: the only code that writes the double-entry ledger (business rules §9).
 * Both methods run inside the caller's transaction, row-lock the reward, are idempotent, and move
 * the reward's status together with the ledger write — the DB verifies at COMMIT that a reward is
 * POSTED ⇔ it has exactly one posting, REVERSED ⇔ posting + mirrored reversal.
 */
@Injectable()
export class LedgerService {
  /**
   * Posts an APPROVED reward: transaction `reward-posting:<rewardId>` with exactly two entries —
   * DEBIT PLATFORM_REWARD_EXPENSE / CREDIT the recipient's MEMBER_REWARDS_PAYABLE — for the reward
   * amount in its unit + currency; then sets the reward POSTED (postedAt = now). Replaying on a
   * POSTED (or later REVERSED) reward returns the existing posting.
   *
   * @param actorUserId approver, or null for system auto-approval.
   * @throws INVALID_STATE_TRANSITION unless the reward is APPROVED (or already posted).
   */
  async postReward(tx: Tx, rewardId: string, actorUserId: string | null): Promise<LedgerPostingResult> {
    const reward = await this.lockReward(tx, rewardId);
    const existing = await tx.ledgerTransaction.findUnique({
      where: { idempotencyKey: postingKey(rewardId) },
      select: { id: true },
    });
    if (existing) return { transactionId: existing.id, created: false };
    if (reward.status !== 'APPROVED') {
      throw new AppError(ErrorCode.InvalidStateTransition, `Only approved rewards can be posted (reward is ${reward.status})`);
    }

    const expense = await this.ensureAccount(tx, 'PLATFORM_REWARD_EXPENSE', null, reward.reward_unit, reward.currency_code);
    const payable = await this.ensureAccount(tx, 'MEMBER_REWARDS_PAYABLE', reward.recipient_user_id, reward.reward_unit, reward.currency_code);
    const entry = { rewardUnit: reward.reward_unit, currencyCode: reward.currency_code, amountMinor: reward.amount_minor };

    const txn = await tx.ledgerTransaction.create({
      data: {
        id: randomUUID(),
        type: 'REWARD_POSTING',
        idempotencyKey: postingKey(rewardId),
        rewardId,
        entryCount: 2,
        debitTotalMinor: reward.amount_minor,
        description: 'Reward posted',
        postedById: actorUserId,
        entries: {
          create: [
            { id: randomUUID(), accountId: expense, direction: 'DEBIT', ...entry },
            { id: randomUUID(), accountId: payable, direction: 'CREDIT', ...entry },
          ],
        },
      },
      select: { id: true, postedAt: true },
    });
    await tx.reward.update({ where: { id: rewardId }, data: { status: 'POSTED', postedAt: txn.postedAt } });
    return { transactionId: txn.id, created: true };
  }

  /**
   * Reverses a POSTED reward with a compensating transaction `reward-reversal:<rewardId>` that
   * mirrors the posting exactly and references it; then sets the reward REVERSED with the actor and
   * reason. Replaying on a REVERSED reward returns the existing reversal.
   *
   * @throws INVALID_STATE_TRANSITION unless the reward is POSTED (or already reversed).
   */
  async reverseReward(tx: Tx, rewardId: string, actorUserId: string, reason: string): Promise<LedgerPostingResult> {
    const reward = await this.lockReward(tx, rewardId);
    const existing = await tx.ledgerTransaction.findUnique({
      where: { idempotencyKey: reversalKey(rewardId) },
      select: { id: true },
    });
    if (existing) return { transactionId: existing.id, created: false };
    if (reward.status !== 'POSTED') {
      throw new AppError(ErrorCode.InvalidStateTransition, `Only posted rewards can be reversed (reward is ${reward.status})`);
    }
    const posting = await tx.ledgerTransaction.findUnique({
      where: { idempotencyKey: postingKey(rewardId) },
      select: { id: true, entryCount: true, debitTotalMinor: true, entries: true },
    });
    if (!posting) {
      throw new AppError(ErrorCode.InvalidStateTransition, 'The reward has no posting to reverse');
    }

    const txn = await tx.ledgerTransaction.create({
      data: {
        id: randomUUID(),
        type: 'REWARD_REVERSAL',
        idempotencyKey: reversalKey(rewardId),
        rewardId,
        reversesTransactionId: posting.id,
        entryCount: posting.entryCount,
        debitTotalMinor: posting.debitTotalMinor,
        description: reason.slice(0, 500),
        postedById: actorUserId,
        entries: {
          create: posting.entries.map((e) => ({
            id: randomUUID(),
            accountId: e.accountId,
            direction: e.direction === 'DEBIT' ? ('CREDIT' as const) : ('DEBIT' as const),
            amountMinor: e.amountMinor,
            rewardUnit: e.rewardUnit,
            currencyCode: e.currencyCode,
          })),
        },
      },
      select: { id: true, postedAt: true },
    });
    await tx.reward.update({
      where: { id: rewardId },
      data: { status: 'REVERSED', reversedAt: txn.postedAt, reversedById: actorUserId, reversalReason: reason.slice(0, 500) },
    });
    return { transactionId: txn.id, created: true };
  }

  /** Account for (type, owner, unit, currency), created race-free with ON CONFLICT DO NOTHING. */
  async ensureAccount(
    tx: Tx,
    type: LedgerAccountType,
    userId: string | null,
    unit: RewardUnit,
    currencyCode: string,
  ): Promise<string> {
    await tx.$executeRaw`
      INSERT INTO "ledger_accounts" ("id", "type", "user_id", "reward_unit", "currency_code", "created_at")
      VALUES (${randomUUID()}::uuid, ${type}::"LedgerAccountType", ${userId}::uuid, ${unit}::"RewardUnit", ${currencyCode}, now())
      ON CONFLICT DO NOTHING`;
    const account = await tx.ledgerAccount.findFirst({
      where: { type, userId, rewardUnit: unit, currencyCode },
      select: { id: true },
    });
    if (!account) throw new AppError(ErrorCode.Internal, 'Ledger account could not be created', 500);
    return account.id;
  }

  private async lockReward(tx: Tx, rewardId: string): Promise<LockedReward> {
    const rows = await tx.$queryRaw<LockedReward[]>`
      SELECT "id", "status"::text AS "status", "recipient_user_id", "amount_minor", "reward_unit", "currency_code"
      FROM "rewards" WHERE "id" = ${rewardId}::uuid FOR UPDATE`;
    const reward = rows[0];
    if (!reward) throw notFound('Reward');
    return reward;
  }
}
