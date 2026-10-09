import { Injectable, NotImplementedException } from '@nestjs/common';
import type { Tx } from '../../common/prisma/prisma.service';

export interface LedgerPostingResult {
  transactionId: string;
}

/**
 * CROSS-MODULE CONTRACT (owned by the ledger slice; consumed by rewards approval and event reversal).
 * Both methods run inside the caller's transaction and are idempotent via the unique
 * `ledger_transactions.idempotency_key`.
 */
@Injectable()
export class LedgerService {
  /**
   * Posts an APPROVED reward (business rules §9): one REWARD_POSTING transaction with idempotency key
   * `reward-posting:<rewardId>` — DEBIT `PLATFORM_REWARD_EXPENSE` / CREDIT the recipient's
   * `MEMBER_REWARDS_PAYABLE` for `reward.amountMinor` in the reward's unit + currency (accounts are
   * created on demand). Does NOT change the reward's status — the caller sets POSTED/postedAt in the
   * same `tx`. Re-posting returns the existing transaction id. The deferred balance trigger validates
   * at COMMIT.
   *
   * @param actorUserId approver, or null for system auto-approval (requiresApproval = false).
   */
  async postReward(tx: Tx, rewardId: string, actorUserId: string | null): Promise<LedgerPostingResult> {
    void tx;
    void rewardId;
    void actorUserId;
    throw new NotImplementedException('ledger slice');
  }

  /**
   * Reverses a POSTED reward: one REWARD_REVERSAL transaction (key `reward-reversal:<rewardId>`,
   * `reversesTransactionId` = the posting) with mirrored entries (DEBIT member payable / CREDIT
   * platform expense). Caller sets the reward to REVERSED in the same `tx`. Idempotent.
   *
   * @throws AppError INVALID_STATE_TRANSITION if the reward has no posting transaction.
   */
  async reverseReward(tx: Tx, rewardId: string, actorUserId: string, reason: string): Promise<LedgerPostingResult> {
    void tx;
    void rewardId;
    void actorUserId;
    void reason;
    throw new NotImplementedException('ledger slice');
  }
}
