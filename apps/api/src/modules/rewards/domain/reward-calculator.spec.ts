import { describe, expect, it } from 'vitest';
import {
  calculateRewards,
  checkEventAgainstPolicy,
  computeBase,
  computeBudget,
  divideRounded,
  type CalcAncestor,
  type CalcPolicy,
  type CalcRule,
  type CalcUnit,
} from './reward-calculator';

const MONEY_INR: CalcUnit = { rewardUnit: 'MONEY', currencyMinorUnits: 2, pointsPerCurrencyUnit: 1 };
const POINTS: CalcUnit = { rewardUnit: 'POINTS', currencyMinorUnits: 2, pointsPerCurrencyUnit: 1 };

const fixed = (level: number, amount: bigint, capMinor: bigint | null = null): CalcRule => ({
  level,
  calcType: 'FIXED',
  fixedAmountMinor: amount,
  percentageBps: null,
  capMinor,
});
const pct = (level: number, bps: number, capMinor: bigint | null = null): CalcRule => ({
  level,
  calcType: 'PERCENTAGE',
  fixedAmountMinor: null,
  percentageBps: bps,
  capMinor,
});

function policy(overrides: Partial<CalcPolicy> = {}): CalcPolicy {
  return {
    id: 'p1',
    version: 1,
    maxDepth: 5,
    budgetBps: 2000,
    maxTotalPerEventMinor: null,
    minEventAmountMinor: 0n,
    ineligibleAncestorBehavior: 'FORFEIT',
    roundingMode: 'HALF_UP',
    triggerEventTypes: ['PRODUCT_SALE'],
    rules: [pct(1, 1000), pct(2, 500), pct(3, 300), pct(4, 200)],
    ...overrides,
  };
}

function chain(n: number, ineligible: number[] = []): CalcAncestor[] {
  return Array.from({ length: n }, (_, i) => ({
    userId: `u${i + 1}`,
    depth: i + 1,
    eligible: !ineligible.includes(i + 1),
    ineligibleReason: ineligible.includes(i + 1) ? 'no active enrollment' : undefined,
  }));
}

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

describe('divideRounded', () => {
  it('applies rounding modes on exact halves and non-halves', () => {
    expect(divideRounded(25n, 10n, 'HALF_UP')).toBe(3n);
    expect(divideRounded(25n, 10n, 'HALF_EVEN')).toBe(2n);
    expect(divideRounded(35n, 10n, 'HALF_EVEN')).toBe(4n);
    expect(divideRounded(25n, 10n, 'DOWN')).toBe(2n);
    expect(divideRounded(26n, 10n, 'HALF_EVEN')).toBe(3n);
    expect(divideRounded(24n, 10n, 'HALF_UP')).toBe(2n);
    expect(divideRounded(20n, 10n, 'HALF_UP')).toBe(2n);
  });

  it('rejects negative numerators', () => {
    expect(() => divideRounded(-1n, 10n, 'DOWN')).toThrow(RangeError);
  });
});

describe('base and budget', () => {
  it('uses the sale amount as base in MONEY mode', () => {
    expect(computeBase(200_000n, MONEY_INR)).toBe(200_000n);
  });

  it('converts sale minor units to points in POINTS mode (floor)', () => {
    expect(computeBase(200_050n, POINTS)).toBe(2000n); // ₹2,000.50 → 2000 points
    expect(computeBase(200_050n, { ...POINTS, pointsPerCurrencyUnit: 10 })).toBe(20_005n);
  });

  it('caps the budget at 50% even if a policy asks for more', () => {
    expect(computeBudget(100_000n, { budgetBps: 9000, maxTotalPerEventMinor: null })).toBe(50_000n);
  });

  it('applies maxTotalPerEventMinor', () => {
    expect(computeBudget(100_000n, { budgetBps: 2000, maxTotalPerEventMinor: 5_000n })).toBe(5_000n);
  });
});

describe('checkEventAgainstPolicy', () => {
  it('rejects event types the policy does not reward', () => {
    expect(checkEventAgainstPolicy({ type: 'SERVICE_COMPLETED', amountMinor: 100n }, policy())).toMatch(/does not reward/);
  });
  it('rejects amounts under the minimum and non-positive amounts', () => {
    expect(checkEventAgainstPolicy({ type: 'PRODUCT_SALE', amountMinor: 99n }, policy({ minEventAmountMinor: 100n }))).toMatch(/minimum/);
    expect(checkEventAgainstPolicy({ type: 'PRODUCT_SALE', amountMinor: 0n }, policy())).toMatch(/greater than zero/);
  });
  it('accepts a valid event', () => {
    expect(checkEventAgainstPolicy({ type: 'PRODUCT_SALE', amountMinor: 100n }, policy())).toBeNull();
  });
});

describe('calculateRewards', () => {
  it('pays percentage levels to each eligible ancestor', () => {
    const r = calculateRewards({ event: { type: 'PRODUCT_SALE', amountMinor: 100_000n }, policy: policy(), unit: MONEY_INR, ancestors: chain(6) });
    expect(r.budgetMinor).toBe(20_000n);
    expect(r.allocations.map((a) => [a.level, a.recipientUserId, a.amountMinor])).toEqual([
      [1, 'u1', 10_000n],
      [2, 'u2', 5_000n],
      [3, 'u3', 3_000n],
      [4, 'u4', 2_000n],
    ]);
    expect(r.totalAllocatedMinor).toBe(20_000n);
    expect(r.warnings).toEqual([]);
  });

  it('stops when the chain ends', () => {
    const r = calculateRewards({ event: { type: 'PRODUCT_SALE', amountMinor: 100_000n }, policy: policy(), unit: MONEY_INR, ancestors: chain(2) });
    expect(r.allocations).toHaveLength(2);
    expect(r.trace.some((t) => t.step === 'level' && t.decision === 'NO_ANCESTOR')).toBe(true);
  });

  it('returns no allocations for a member without sponsor', () => {
    const r = calculateRewards({ event: { type: 'PRODUCT_SALE', amountMinor: 100_000n }, policy: policy(), unit: MONEY_INR, ancestors: [] });
    expect(r.allocations).toEqual([]);
    expect(r.totalAllocatedMinor).toBe(0n);
  });

  it('FORFEIT: an ineligible ancestor loses the level; nobody else takes it', () => {
    const r = calculateRewards({ event: { type: 'PRODUCT_SALE', amountMinor: 100_000n }, policy: policy(), unit: MONEY_INR, ancestors: chain(4, [2]) });
    expect(r.allocations.map((a) => [a.level, a.recipientUserId])).toEqual([
      [1, 'u1'],
      [3, 'u3'],
      [4, 'u4'],
    ]);
    expect(r.trace.some((t) => t.step === 'level' && t.decision === 'INELIGIBLE_FORFEITED')).toBe(true);
  });

  it('COMPRESS: the next eligible ancestor moves up into the level', () => {
    const r = calculateRewards({
      event: { type: 'PRODUCT_SALE', amountMinor: 100_000n },
      policy: policy({ ineligibleAncestorBehavior: 'COMPRESS' }),
      unit: MONEY_INR,
      ancestors: chain(6, [2, 3]),
    });
    expect(r.allocations.map((a) => [a.level, a.recipientUserId, a.depth])).toEqual([
      [1, 'u1', 1],
      [2, 'u4', 4],
      [3, 'u5', 5],
      [4, 'u6', 6],
    ]);
  });

  it('never exceeds the budget: fixed amounts are truncated in level order', () => {
    // Notebook-style fixed ladder against a ₹2,000 sale with a 20% budget (₹400).
    const r = calculateRewards({
      event: { type: 'PRODUCT_SALE', amountMinor: 200_000n },
      policy: policy({ rules: [fixed(1, 50_000n), fixed(2, 40_000n), fixed(3, 30_000n), fixed(4, 20_000n), fixed(5, 10_000n)] }),
      unit: MONEY_INR,
      ancestors: chain(5),
    });
    expect(r.budgetMinor).toBe(40_000n);
    expect(r.allocations.map((a) => a.amountMinor)).toEqual([40_000n]);
    expect(r.allocations[0]?.budgetLimited).toBe(true);
    expect(sum(r.allocations.map((a) => a.amountMinor))).toBeLessThanOrEqual(r.budgetMinor);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('applies per-level caps before the budget', () => {
    const r = calculateRewards({
      event: { type: 'PRODUCT_SALE', amountMinor: 1_000_000n },
      policy: policy({ rules: [pct(1, 1000, 25_000n)] }),
      unit: MONEY_INR,
      ancestors: chain(1),
    });
    expect(r.allocations[0]).toMatchObject({ amountMinor: 25_000n, capped: true, budgetLimited: false });
  });

  it('respects maxDepth even when more ancestors and rules exist', () => {
    const r = calculateRewards({
      event: { type: 'PRODUCT_SALE', amountMinor: 100_000n },
      policy: policy({ maxDepth: 2 }),
      unit: MONEY_INR,
      ancestors: chain(6),
    });
    expect(r.allocations.map((a) => a.level)).toEqual([1, 2]);
  });

  it('skips levels without a rule but continues upward', () => {
    const r = calculateRewards({
      event: { type: 'PRODUCT_SALE', amountMinor: 100_000n },
      policy: policy({ rules: [pct(1, 1000), pct(3, 500)] }),
      unit: MONEY_INR,
      ancestors: chain(3),
    });
    expect(r.allocations.map((a) => [a.level, a.recipientUserId])).toEqual([
      [1, 'u1'],
      [3, 'u3'],
    ]);
  });

  it('computes points rewards from the converted base', () => {
    const r = calculateRewards({
      event: { type: 'PRODUCT_SALE', amountMinor: 250_000n }, // ₹2,500 → 2,500 points base
      policy: policy({ rules: [pct(1, 1000), fixed(2, 100n)] }),
      unit: POINTS,
      ancestors: chain(2),
    });
    expect(r.baseMinor).toBe(2_500n);
    expect(r.allocations.map((a) => a.amountMinor)).toEqual([250n, 100n]);
  });

  it('rounds percentages using the policy rounding mode', () => {
    const base = { event: { type: 'PRODUCT_SALE' as const, amountMinor: 125n }, unit: MONEY_INR, ancestors: chain(1) };
    // 125 × 1000 bps / 10000 = 12.5
    expect(calculateRewards({ ...base, policy: policy({ budgetBps: 5000, rules: [pct(1, 1000)], roundingMode: 'HALF_UP' }) }).allocations[0]?.amountMinor).toBe(13n);
    expect(calculateRewards({ ...base, policy: policy({ budgetBps: 5000, rules: [pct(1, 1000)], roundingMode: 'HALF_EVEN' }) }).allocations[0]?.amountMinor).toBe(12n);
    expect(calculateRewards({ ...base, policy: policy({ budgetBps: 5000, rules: [pct(1, 1000)], roundingMode: 'DOWN' }) }).allocations[0]?.amountMinor).toBe(12n);
  });

  it('drops zero-amount levels (tiny sales)', () => {
    const r = calculateRewards({
      event: { type: 'PRODUCT_SALE', amountMinor: 3n },
      policy: policy({ roundingMode: 'DOWN' }),
      unit: MONEY_INR,
      ancestors: chain(4),
    });
    expect(r.allocations).toEqual([]);
  });

  it('is deterministic and records a full trace', () => {
    const input = { event: { type: 'PRODUCT_SALE' as const, amountMinor: 100_000n }, policy: policy(), unit: MONEY_INR, ancestors: chain(5, [3]) };
    expect(calculateRewards(input)).toEqual(calculateRewards(input));
    const r = calculateRewards(input);
    expect(r.trace[0]?.step).toBe('base');
    expect(r.trace[1]?.step).toBe('budget');
    expect(r.trace.filter((t) => t.step === 'level').length).toBe(5);
  });

  it('property: total never exceeds budget and recipients are unique across random policies', () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let i = 0; i < 500; i += 1) {
      const maxDepth = 1 + rand(10);
      const rules: CalcRule[] = [];
      for (let level = 1; level <= maxDepth; level += 1) {
        if (rand(4) === 0) continue;
        rules.push(rand(2) === 0 ? fixed(level, BigInt(1 + rand(100_000))) : pct(level, 1 + rand(5000), rand(3) === 0 ? BigInt(1 + rand(50_000)) : null));
      }
      const p = policy({
        maxDepth,
        budgetBps: 1 + rand(5000),
        rules,
        ineligibleAncestorBehavior: rand(2) === 0 ? 'FORFEIT' : 'COMPRESS',
        roundingMode: (['HALF_UP', 'HALF_EVEN', 'DOWN'] as const)[rand(3)]!,
        maxTotalPerEventMinor: rand(3) === 0 ? BigInt(1 + rand(100_000)) : null,
      });
      const ancestors = chain(rand(20), Array.from({ length: rand(5) }, () => 1 + rand(20)));
      const amount = BigInt(1 + rand(10_000_000));
      const r = calculateRewards({ event: { type: 'PRODUCT_SALE', amountMinor: amount }, policy: p, unit: rand(2) ? MONEY_INR : POINTS, ancestors });
      const total = sum(r.allocations.map((a) => a.amountMinor));
      expect(total).toBe(r.totalAllocatedMinor);
      expect(total <= r.budgetMinor).toBe(true);
      expect(r.budgetMinor * 2n <= r.baseMinor + 1n).toBe(true);
      expect(new Set(r.allocations.map((a) => a.recipientUserId)).size).toBe(r.allocations.length);
      expect(new Set(r.allocations.map((a) => a.level)).size).toBe(r.allocations.length);
      for (const a of r.allocations) {
        expect(a.amountMinor > 0n).toBe(true);
        expect(a.level <= maxDepth).toBe(true);
        expect(ancestors.find((x) => x.userId === a.recipientUserId)?.eligible).toBe(true);
      }
    }
  });
});
