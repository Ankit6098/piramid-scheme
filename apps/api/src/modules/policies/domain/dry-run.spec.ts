import { describe, expect, it } from 'vitest';
import type { CalcPolicy } from '../../rewards/domain/reward-calculator';
import { runDryRun, syntheticAncestors } from './dry-run';

const policy: CalcPolicy = {
  id: 'p1',
  version: 3,
  maxDepth: 3,
  budgetBps: 2000,
  maxTotalPerEventMinor: null,
  minEventAmountMinor: 10_000n,
  ineligibleAncestorBehavior: 'FORFEIT',
  roundingMode: 'HALF_UP',
  triggerEventTypes: ['PRODUCT_SALE'],
  rules: [
    { level: 1, calcType: 'PERCENTAGE', percentageBps: 1000, fixedAmountMinor: null, capMinor: null },
    { level: 2, calcType: 'PERCENTAGE', percentageBps: 500, fixedAmountMinor: null, capMinor: null },
    { level: 3, calcType: 'FIXED', percentageBps: null, fixedAmountMinor: 5_000n, capMinor: null },
  ],
};
const unit = { rewardUnit: 'MONEY' as const, currencyCode: 'INR', currencyMinorUnits: 2, pointsPerCurrencyUnit: 1 };

describe('runDryRun', () => {
  it('allocates against a synthetic chain and hides synthetic ids', () => {
    const r = runDryRun({
      policyVersionId: 'p1',
      mode: 'SYNTHETIC',
      eventType: 'PRODUCT_SALE',
      saleAmountMinor: 100_000n,
      occurredAt: null,
      policy,
      unit,
      ancestors: syntheticAncestors([{ eligible: true }, { eligible: false }, { eligible: true }]),
    });
    expect(r.applicable).toBe(true);
    expect(r.baseMinor).toBe('100000');
    expect(r.budgetMinor).toBe('20000');
    expect(r.hardCapMinor).toBe('50000');
    expect(r.allocations.map((a) => [a.level, a.amountMinor])).toEqual([
      [1, '10000'],
      [3, '5000'],
    ]);
    expect(r.totalAllocatedMinor).toBe('15000');
    expect(r.unallocatedMinor).toBe('5000');
    expect(r.levels.map((l) => l.decision)).toEqual(['AWARDED', 'INELIGIBLE_FORFEITED', 'AWARDED']);
    expect(r.allocations.every((a) => a.userId === null)).toBe(true);
    expect(JSON.stringify(r.trace)).not.toContain('synthetic:');
  });

  it('reports sales the engine would reject without allocating', () => {
    const r = runDryRun({
      policyVersionId: 'p1',
      mode: 'SYNTHETIC',
      eventType: 'SERVICE_COMPLETED',
      saleAmountMinor: 100_000n,
      occurredAt: null,
      policy,
      unit,
      ancestors: syntheticAncestors([{ eligible: true }]),
    });
    expect(r.applicable).toBe(false);
    expect(r.notApplicableReason).toMatch(/does not reward SERVICE_COMPLETED/);
    expect(r.allocations).toEqual([]);
    expect(r.totalAllocatedMinor).toBe('0');
  });

  it('converts sales to points in POINTS mode', () => {
    const r = runDryRun({
      policyVersionId: 'p1',
      mode: 'MEMBER',
      eventType: 'PRODUCT_SALE',
      saleAmountMinor: 123_456n, // ₹1,234.56 × 2 points → 2 469 points
      occurredAt: new Date('2026-10-10T00:00:00Z'),
      policy: { ...policy, rules: [policy.rules[0]!] },
      unit: { ...unit, rewardUnit: 'POINTS', pointsPerCurrencyUnit: 2 },
      ancestors: [{ userId: 'u1', depth: 1, eligible: true, displayName: 'Rahul V.' }],
    });
    expect(r.baseMinor).toBe('2469');
    expect(r.allocations).toEqual([
      expect.objectContaining({ level: 1, userId: 'u1', displayName: 'Rahul V.', amountMinor: '247' }),
    ]);
    expect(r.occurredAt).toBe('2026-10-10T00:00:00.000Z');
  });
});
