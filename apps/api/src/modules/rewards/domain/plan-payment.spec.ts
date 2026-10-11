import { describe, expect, it } from 'vitest';
import {
  planPaymentFlagDedupeKey,
  planPaymentFlagDetails,
  planPaymentRelation,
  planPaymentReviewMessage,
  sortPlanPaymentMatches,
} from './plan-payment';

const at = (iso: string) => new Date(iso);

describe('plan-payment lookalikes', () => {
  it('classifies own (depth 0) and downline payments', () => {
    expect(planPaymentRelation({ depth: 0 })).toBe('OWN');
    expect(planPaymentRelation({ depth: 1 })).toBe('DOWNLINE');
    expect(planPaymentRelation({ depth: 7 })).toBe('DOWNLINE');
  });

  it('sorts own payments first, then by depth, newest payment first', () => {
    const sorted = sortPlanPaymentMatches([
      { id: 'a', depth: 2, paymentRecordedAt: at('2026-10-01T00:00:00Z') },
      { id: 'b', depth: 1, paymentRecordedAt: at('2026-10-01T00:00:00Z') },
      { id: 'c', depth: 1, paymentRecordedAt: at('2026-10-02T00:00:00Z') },
      { id: 'd', depth: 0, paymentRecordedAt: at('2026-09-01T00:00:00Z') },
    ]);
    expect(sorted.map((m) => m.id)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('builds one dedupe key per sale and bounded flag details', () => {
    expect(planPaymentFlagDedupeKey('e1')).toBe('PLAN_PAYMENT_LOOKALIKE:e1');
    const many = Array.from({ length: 8 }, (_, i) => ({ depth: i + 1, payerUserId: `u${i}`, enrollmentId: `en${i}` }));
    const details = planPaymentFlagDetails({ eventId: 'e1', externalId: 'ORD-1', amountMinor: 49_900n, currencyCode: 'INR' }, many);
    expect(details).toMatch(/ORD-1/);
    expect(details).toMatch(/downline depth 1 \(member u0, enrollment en0\)/);
    expect(details).toMatch(/and 3 more/);
    expect(details.length).toBeLessThanOrEqual(2000);
  });

  it('explains the review to reviewers', () => {
    expect(planPaymentReviewMessage([])).toBeNull();
    expect(planPaymentReviewMessage([{ depth: 1 }])).toMatch(/a plan payment by a member of the credited member's downline/);
    expect(planPaymentReviewMessage([{ depth: 1 }, { depth: 2 }])).toMatch(/2 plan payments/);
    expect(planPaymentReviewMessage([{ depth: 0 }])).toMatch(/own plan payment/);
    expect(planPaymentReviewMessage([{ depth: 0 }, { depth: 3 }])).toMatch(/own plan payment and a plan payment by a member of their downline/);
  });
});
