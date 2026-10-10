/**
 * Segregation of duties for reward decisions (business rules §3, §9). The database enforces the
 * same rules (CHECK ck_rewards_sod + trg_rewards_guard); checking first turns them into friendly
 * 409s instead of INVARIANT_VIOLATION. Pure.
 */
import { RewardSodRule } from '@app/shared';

export type RewardDecisionKind = 'approve' | 'reject' | 'reverse';

export interface SodFacts {
  actorUserId: string;
  recipientUserId: string;
  /** Admin who recorded the sale (null for API/webhook sales). */
  saleRecordedById: string | null;
}

/** The first rule the decision would break, or null. */
export function findSodViolation(kind: RewardDecisionKind, facts: SodFacts): RewardSodRule | null {
  if (facts.actorUserId === facts.recipientUserId) return RewardSodRule.OwnReward;
  if (kind === 'approve' && facts.saleRecordedById !== null && facts.actorUserId === facts.saleRecordedById) {
    return RewardSodRule.RecordedSale;
  }
  return null;
}

const VERB: Record<RewardDecisionKind, string> = { approve: 'approve', reject: 'reject', reverse: 'reverse' };

export function sodMessage(rule: RewardSodRule, kind: RewardDecisionKind): string {
  if (rule === RewardSodRule.OwnReward) {
    return `You cannot ${VERB[kind]} a reward credited to you. Another reviewer must decide on it.`;
  }
  return 'You recorded this sale, so you cannot approve its rewards. Another reviewer must approve them.';
}
