/**
 * Plan-payment lookalikes (business rules §0.1): a member's own plan payment — or a recruit's — must
 * never fund rewards. A sale "resembles" a plan payment when the amounts are equal, the payment was
 * made in a program with the sale's currency, and it was recorded within ±2 days of the sale date or
 * of the time the sale was recorded (SQL: `app_plan_payment_matches`). The subject's OWN payment is
 * refused outright (intake + DB); a DOWNLINE payment is not (an honest sale can match an amount by
 * coincidence) — the sale is flagged, its rewards always wait for a reviewer, and it is queued in
 * reconciliation.
 */
import { FlagKind, type PlanPaymentRelation } from '@app/shared';

/** Plan payments recorded within ± this window of the sale date or recording time match (mirrors SQL). */
export const PLAN_PAYMENT_WINDOW_MS = 2 * 86_400_000;

export const PLAN_PAYMENT_FLAG_KIND = FlagKind.PlanPaymentLookalike;

export interface PlanPaymentMatch {
  enrollmentId: string;
  payerUserId: string;
  programId: string;
  /** 0 = the subject's own payment; ≥ 1 = the payer's depth below the subject. */
  depth: number;
  paymentRecordedAt: Date;
}

export function planPaymentRelation(match: Pick<PlanPaymentMatch, 'depth'>): PlanPaymentRelation {
  return match.depth === 0 ? 'OWN' : 'DOWNLINE';
}

/** Own payments first, then by depth, newest payment first. */
export function sortPlanPaymentMatches<T extends Pick<PlanPaymentMatch, 'depth' | 'paymentRecordedAt'>>(matches: readonly T[]): T[] {
  return [...matches].sort((a, b) => a.depth - b.depth || b.paymentRecordedAt.getTime() - a.paymentRecordedAt.getTime());
}

/** One open flag per sale (partial unique index on OPEN dedupe keys; never re-raised once reviewed). */
export function planPaymentFlagDedupeKey(eventId: string): string {
  return `${PLAN_PAYMENT_FLAG_KIND}:${eventId}`;
}

/** Reviewer-facing explanation of why a sale is held for compliance review (null = nothing to review). */
export function planPaymentReviewMessage(matches: readonly Pick<PlanPaymentMatch, 'depth'>[]): string | null {
  if (matches.length === 0) return null;
  const own = matches.some((m) => m.depth === 0);
  const downline = matches.filter((m) => m.depth > 0).length;
  const who = own
    ? downline > 0
      ? "the credited member's own plan payment and a plan payment by a member of their downline"
      : "the credited member's own plan payment"
    : downline === 1
      ? "a plan payment by a member of the credited member's downline"
      : `${downline} plan payments by members of the credited member's downline`;
  return (
    `This sale has the same amount as ${who}, recorded within 2 days of the sale. Plan payments never earn rewards: ` +
    'confirm that this is a real sale to an end customer before approving its rewards, otherwise reverse the sale.'
  );
}

/** `member_flags.details` (≤ 2000 chars) for the PLAN_PAYMENT_LOOKALIKE flag of a sale. */
export function planPaymentFlagDetails(
  sale: { eventId: string; externalId: string; amountMinor: bigint; currencyCode: string },
  matches: readonly Pick<PlanPaymentMatch, 'depth' | 'payerUserId' | 'enrollmentId'>[],
): string {
  const list = matches
    .slice(0, 5)
    .map((m) => `${planPaymentRelation(m) === 'OWN' ? 'own payment' : `downline depth ${m.depth}`} (member ${m.payerUserId}, enrollment ${m.enrollmentId})`)
    .join('; ');
  const more = matches.length > 5 ? `; and ${matches.length - 5} more` : '';
  return (
    `Sale ${sale.externalId} (event ${sale.eventId}, ${sale.amountMinor.toString()} ${sale.currencyCode} minor units) ` +
    `has the same amount as plan payment(s) recorded within 2 days: ${list}${more}. ` +
    'Its rewards are held for manual approval.'
  ).slice(0, 2000);
}
