import { describe, expect, it } from 'vitest';
import { applyChanges, auditDiff, displayNameOf, stateFromRow, type PolicyRowLike } from './policy-state';

const row: PolicyRowLike = {
  name: 'Policy v1',
  notes: null,
  triggerEventTypes: ['PRODUCT_SALE'],
  maxDepth: 3,
  budgetBps: 2000,
  maxTotalPerEventMinor: null,
  minEventAmountMinor: 0n,
  pointsPerCurrencyUnit: 1,
  ineligibleAncestorBehavior: 'FORFEIT',
  roundingMode: 'HALF_UP',
  requiresApproval: true,
  requireActiveEnrollment: true,
  rules: [
    { level: 2, calcType: 'PERCENTAGE', fixedAmountMinor: null, percentageBps: 500, capMinor: null },
    { level: 1, calcType: 'FIXED', fixedAmountMinor: 1_000n, percentageBps: null, capMinor: null },
  ],
};

describe('policy state', () => {
  it('sorts stored rules by level and keeps the order of submitted rules', () => {
    expect(stateFromRow(row).rules.map((r) => r.level)).toEqual([1, 2]);
    const next = applyChanges(stateFromRow(row), {
      rules: [
        { level: 3, calcType: 'PERCENTAGE', fixedAmountMinor: null, percentageBps: 100, capMinor: '50' },
        { level: 1, calcType: 'FIXED', fixedAmountMinor: '700', percentageBps: null, capMinor: null },
      ],
      notes: '',
    });
    expect(next.rules.map((r) => [r.level, r.fixedAmountMinor, r.capMinor])).toEqual([
      [3, null, 50n],
      [1, 700n, null],
    ]);
    expect(next.notes).toBeNull();
  });

  it('diffs only changed fields, independent of rule order', () => {
    const before = stateFromRow(row);
    const reordered = applyChanges(before, {
      rules: [
        { level: 2, calcType: 'PERCENTAGE', fixedAmountMinor: null, percentageBps: 500, capMinor: null },
        { level: 1, calcType: 'FIXED', fixedAmountMinor: '1000', percentageBps: null, capMinor: null },
      ],
    });
    expect(auditDiff(before, reordered)).toEqual({ before: {}, after: {} });
    const changed = applyChanges(before, { budgetBps: 2500 });
    expect(auditDiff(before, changed)).toEqual({ before: { budgetBps: 2000 }, after: { budgetBps: 2500 } });
  });

  it('builds member display names', () => {
    expect(displayNameOf('Priya Nair')).toBe('Priya N.');
    expect(displayNameOf('  Anita  Kumari Sharma ')).toBe('Anita S.');
    expect(displayNameOf('Madonna')).toBe('Madonna');
  });
});
