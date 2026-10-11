import { describe, expect, it } from 'vitest';
import type { CalcPolicy } from '../../rewards/domain/reward-calculator';
import {
  decideRevision,
  deriveOutcome,
  evaluateIntake,
  saleRequestHash,
  type ExistingRevision,
  type IntakeEvaluationInput,
  type SaleFacts,
} from './intake';

const facts: SaleFacts = {
  programId: 'p1',
  type: 'PRODUCT_SALE',
  externalId: 'ORD-1',
  customerReference: 'CUST-1',
  subjectUserId: 'u1',
  amountMinor: 100_000n,
  currencyCode: 'INR',
  occurredAt: new Date('2026-10-10T10:00:00.000Z'),
  supersedesEventId: null,
};

describe('saleRequestHash', () => {
  it('is stable and sensitive to every fact', () => {
    const h = saleRequestHash(facts);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(saleRequestHash({ ...facts, occurredAt: new Date('2026-10-10T10:00:00Z') })).toBe(h);
    expect(saleRequestHash({ ...facts, amountMinor: 100_001n })).not.toBe(h);
    expect(saleRequestHash({ ...facts, programId: 'p2' })).not.toBe(h);
    expect(saleRequestHash({ ...facts, supersedesEventId: 'e0' })).not.toBe(h);
  });
});

describe('decideRevision', () => {
  const rev = (o: Partial<ExistingRevision>): ExistingRevision => ({
    id: 'e0',
    revision: 0,
    status: 'PROCESSED',
    requestHash: 'a',
    visible: true,
    ...o,
  });

  it('creates revision 0 for a new sale', () => {
    expect(decideRevision([], 'a', null)).toEqual({ kind: 'create', revision: 0, supersedesEventId: null });
    expect(decideRevision([], 'a', 'e9')).toEqual({ kind: 'conflict', code: 'NOTHING_TO_SUPERSEDE' });
  });

  it('replays an identical request only for callers who may see it', () => {
    expect(decideRevision([rev({})], 'a', null)).toEqual({ kind: 'replay', eventId: 'e0' });
    expect(decideRevision([rev({ visible: false })], 'a', null)).toEqual({ kind: 'conflict', code: 'IDEMPOTENCY' });
  });

  it('conflicts on different facts for a live sale', () => {
    expect(decideRevision([rev({ status: 'RECEIVED' })], 'b', null)).toEqual({ kind: 'conflict', code: 'IDEMPOTENCY' });
    expect(decideRevision([rev({})], 'b', 'e0')).toEqual({ kind: 'conflict', code: 'NOT_SUPERSEDABLE' });
  });

  it('supersedes the latest REJECTED/REVERSED revision', () => {
    const history = [rev({ status: 'REJECTED' }), rev({ id: 'e1', revision: 1, status: 'REVERSED', requestHash: 'b' })];
    expect(decideRevision(history, 'c', null)).toEqual({ kind: 'create', revision: 2, supersedesEventId: 'e1' });
    expect(decideRevision(history, 'c', 'e1')).toEqual({ kind: 'create', revision: 2, supersedesEventId: 'e1' });
    expect(decideRevision(history, 'c', 'e0')).toEqual({ kind: 'conflict', code: 'STALE_SUPERSEDE' });
    // A retry of an older request still replays that revision.
    expect(decideRevision(history, 'a', null)).toEqual({ kind: 'replay', eventId: 'e0' });
  });

  it('never reveals a sale of a program the caller cannot see', () => {
    expect(decideRevision([rev({ status: 'REJECTED', visible: false })], 'b', null)).toEqual({ kind: 'conflict', code: 'IDEMPOTENCY' });
  });
});

describe('evaluateIntake', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const policy: CalcPolicy = {
    id: 'pv',
    version: 2,
    maxDepth: 2,
    budgetBps: 2000,
    maxTotalPerEventMinor: null,
    minEventAmountMinor: 50_000n,
    ineligibleAncestorBehavior: 'FORFEIT',
    roundingMode: 'HALF_UP',
    triggerEventTypes: ['PRODUCT_SALE'],
    rules: [],
  };
  const ok: IntakeEvaluationInput = {
    now,
    type: 'PRODUCT_SALE',
    amountMinor: 100_000n,
    occurredAt: new Date('2026-10-10T11:00:00Z'),
    offeringActive: true,
    program: { status: 'ACTIVE', startsAt: new Date('2026-09-01T00:00:00Z'), endsAt: new Date('2027-09-01T00:00:00Z'), lateEventGraceDays: 30 },
    statusAtSale: 'ACTIVE',
    subject: { status: 'ACTIVE', emailVerified: true },
    planPayment: null,
    policy,
    unit: { rewardUnit: 'MONEY', currencyMinorUnits: 2, pointsPerCurrencyUnit: 1 },
  };
  const code = (o: Partial<IntakeEvaluationInput>) => evaluateIntake({ ...ok, ...o })?.code ?? null;

  it('accepts a valid sale', () => expect(code({})).toBeNull());

  it('rejects future and out-of-period sales', () => {
    expect(code({ occurredAt: new Date(now.getTime() + 4 * 60_000) })).toBeNull();
    expect(code({ occurredAt: new Date(now.getTime() + 6 * 60_000) })).toBe('FUTURE_SALE');
    expect(code({ occurredAt: new Date('2026-08-31T23:59:59Z') })).toBe('OUTSIDE_PROGRAM_PERIOD');
  });

  it('rejects unapproved offerings and plan payments', () => {
    expect(code({ offeringActive: false })).toBe('OFFERING_NOT_APPROVED');
    expect(code({ planPayment: 'REFERENCE' })).toBe('PLAN_PAYMENT');
    expect(code({ planPayment: 'AMOUNT' })).toBe('PLAN_PAYMENT');
  });

  it('requires the program to have been active at the sale and within the late window', () => {
    expect(code({ statusAtSale: 'PAUSED' })).toBe('PROGRAM_NOT_ACTIVE');
    expect(code({ statusAtSale: null })).toBe('PROGRAM_NOT_ACTIVE');
    const ended = { status: 'COMPLETED' as const, startsAt: ok.program.startsAt, endsAt: new Date('2026-10-10T11:30:00Z'), lateEventGraceDays: 0 };
    expect(code({ program: ended })).toBe('LATE_WINDOW_CLOSED');
    expect(code({ program: { ...ended, lateEventGraceDays: 1 } })).toBeNull();
  });

  it('requires an active subject and an applicable policy', () => {
    expect(code({ subject: { status: 'SUSPENDED', emailVerified: true } })).toBe('MEMBER_NOT_ACTIVE');
    expect(code({ policy: null })).toBe('NO_POLICY');
    expect(code({ type: 'SERVICE_COMPLETED' })).toBe('POLICY_NOT_APPLICABLE');
    expect(evaluateIntake({ ...ok, amountMinor: 49_999n })?.reason).toMatch(/below the policy minimum/);
  });

  it('rejects a POINTS sale whose converted base would not fit a bigint (it could never be processed)', () => {
    const points = { rewardUnit: 'POINTS' as const, currencyMinorUnits: 2, pointsPerCurrencyUnit: 1_000_000 };
    const huge = 999_999_999_999_999_999n; // 18 digits: the contract maximum
    expect(code({ unit: points, amountMinor: huge })).toBe('AMOUNT_TOO_LARGE');
    expect(evaluateIntake({ ...ok, unit: points, amountMinor: huge })?.reason).toMatch(/too large/);
    // 2^63 − 1 points is the largest storable base (base = amount × 10^6 / 10^2).
    expect(code({ unit: points, amountMinor: 922_337_203_685_477n })).toBeNull();
    expect(code({ unit: points, amountMinor: 922_337_203_685_478n })).toBe('AMOUNT_TOO_LARGE');
    // MONEY bases equal the sale amount, which the contract caps below 2^63.
    expect(code({ amountMinor: huge })).toBeNull();
  });
});

describe('deriveOutcome', () => {
  it('maps status and calculation outcome', () => {
    expect(deriveOutcome('RECEIVED', null)).toBe('PENDING');
    expect(deriveOutcome('REJECTED', null)).toBe('REJECTED');
    expect(deriveOutcome('REVERSED', 'REWARDS_CREATED')).toBe('REVERSED');
    expect(deriveOutcome('PROCESSED', 'REWARDS_CREATED')).toBe('REWARDS_CREATED');
    expect(deriveOutcome('PROCESSED', 'NO_ELIGIBLE_RECIPIENTS')).toBe('NO_ELIGIBLE_RECIPIENTS');
  });
});
