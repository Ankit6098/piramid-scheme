import { describe, expect, it } from 'vitest';
import { breakEvenSaleMinor, hasErrors, validatePolicy, type PolicyContext, type PolicyDraft } from './policy-validation';

const now = new Date('2026-10-10T00:00:00Z');
const ctx: PolicyContext = { programMaxDepth: 5, programStatus: 'ACTIVE', now, forPublish: true };

function draft(overrides: Partial<PolicyDraft> = {}): PolicyDraft {
  return {
    maxDepth: 3,
    budgetBps: 2000,
    maxTotalPerEventMinor: null,
    minEventAmountMinor: 0n,
    triggerEventTypes: ['PRODUCT_SALE'],
    effectiveFrom: new Date('2026-10-11T00:00:00Z'),
    effectiveTo: null,
    rules: [
      { level: 1, calcType: 'PERCENTAGE', percentageBps: 1000, fixedAmountMinor: null, capMinor: null },
      { level: 2, calcType: 'PERCENTAGE', percentageBps: 500, fixedAmountMinor: null, capMinor: null },
    ],
    ...overrides,
  };
}

const paths = (d: PolicyDraft, c: PolicyContext = ctx) =>
  validatePolicy(d, c)
    .filter((i) => i.severity === 'error')
    .map((i) => i.path);

describe('validatePolicy', () => {
  it('accepts a valid percentage policy', () => {
    expect(validatePolicy(draft(), ctx)).toEqual([]);
  });

  it('rejects budgets above the 50% hard cap', () => {
    expect(paths(draft({ budgetBps: 5001 }))).toContain('budgetBps');
    expect(paths(draft({ budgetBps: 0 }))).toContain('budgetBps');
  });

  it('rejects depth beyond the program ceiling', () => {
    expect(paths(draft({ maxDepth: 6 }))).toContain('maxDepth');
  });

  it('rejects percentage totals above the budget', () => {
    const d = draft({
      budgetBps: 1000,
      rules: [
        { level: 1, calcType: 'PERCENTAGE', percentageBps: 800, fixedAmountMinor: null, capMinor: null },
        { level: 2, calcType: 'PERCENTAGE', percentageBps: 300, fixedAmountMinor: null, capMinor: null },
      ],
    });
    expect(paths(d)).toContain('rules');
  });

  it('rejects malformed rules', () => {
    const d = draft({
      rules: [
        { level: 1, calcType: 'FIXED', percentageBps: null, fixedAmountMinor: 0n, capMinor: null },
        { level: 1, calcType: 'PERCENTAGE', percentageBps: 100, fixedAmountMinor: 5n, capMinor: -1n },
        { level: 4, calcType: 'PERCENTAGE', percentageBps: 100, fixedAmountMinor: null, capMinor: null },
      ],
    });
    const p = paths(d);
    expect(p).toEqual(
      expect.arrayContaining(['rules.0.fixedAmountMinor', 'rules.1.level', 'rules.1.fixedAmountMinor', 'rules.1.capMinor', 'rules.2.level']),
    );
  });

  it('requires at least one rule and one trigger type', () => {
    expect(paths(draft({ rules: [], triggerEventTypes: [] }))).toEqual(expect.arrayContaining(['rules', 'triggerEventTypes']));
  });

  it('blocks retroactive publication but not draft saves', () => {
    const past = draft({ effectiveFrom: new Date('2026-10-01T00:00:00Z') });
    expect(paths(past)).toContain('effectiveFrom');
    expect(paths(past, { ...ctx, forPublish: false })).not.toContain('effectiveFrom');
  });

  it('blocks completed/archived programs', () => {
    expect(paths(draft(), { ...ctx, programStatus: 'ARCHIVED' })).toContain('program');
  });

  it('warns (not errors) when fixed amounts cannot be funded by small sales', () => {
    const d = draft({
      rules: [
        { level: 1, calcType: 'FIXED', percentageBps: null, fixedAmountMinor: 50_000n, capMinor: null },
        { level: 2, calcType: 'FIXED', percentageBps: null, fixedAmountMinor: 40_000n, capMinor: null },
      ],
    });
    const issues = validatePolicy(d, ctx);
    expect(hasErrors(issues)).toBe(false);
    expect(issues.find((i) => i.path === 'minEventAmountMinor')?.message).toMatch(/450000/);
  });

  it('formats the break-even sale in the sale currency when the unit is known', () => {
    const d = draft({
      rules: [{ level: 1, calcType: 'FIXED', percentageBps: null, fixedAmountMinor: 90_000n, capMinor: null }],
    });
    const issue = validatePolicy(d, { ...ctx, unit: { rewardUnit: 'MONEY', currencyCode: 'INR', currencyMinorUnits: 2 } }).find(
      (i) => i.code === 'FIXED_BREAK_EVEN',
    );
    expect(issue?.message).toContain('4,500.00');
    // A minimum sale at the break-even point silences the warning.
    expect(validatePolicy({ ...d, minEventAmountMinor: 450_000n }, ctx).some((i) => i.code === 'FIXED_BREAK_EVEN')).toBe(false);
  });

  it('computes the break-even for POINTS programs through the points rate', () => {
    // 100 points at 20% budget → base ≥ 500 points; 2 points per rupee (2 minor units) → sale ≥ ₹250.00.
    const d = draft({
      pointsPerCurrencyUnit: 2,
      rules: [{ level: 1, calcType: 'FIXED', percentageBps: null, fixedAmountMinor: 100n, capMinor: null }],
    });
    const pointsCtx = { ...ctx, unit: { rewardUnit: 'POINTS' as const, currencyCode: 'INR', currencyMinorUnits: 2 } };
    const issue = validatePolicy(d, pointsCtx).find((i) => i.code === 'FIXED_BREAK_EVEN');
    expect(issue?.message).toContain('250.00');
    expect(validatePolicy({ ...d, minEventAmountMinor: 25_000n }, pointsCtx).some((i) => i.code === 'FIXED_BREAK_EVEN')).toBe(false);
    expect(validatePolicy({ ...d, minEventAmountMinor: 24_999n }, pointsCtx).some((i) => i.code === 'FIXED_BREAK_EVEN')).toBe(true);
  });

  it('uses capped fixed amounts and warns about caps without effect', () => {
    const d = draft({
      rules: [
        { level: 1, calcType: 'FIXED', percentageBps: null, fixedAmountMinor: 10_000n, capMinor: 2_000n },
        { level: 2, calcType: 'FIXED', percentageBps: null, fixedAmountMinor: 1_000n, capMinor: 5_000n },
      ],
    });
    const issues = validatePolicy(d, ctx);
    expect(issues.find((i) => i.code === 'CAP_NO_EFFECT')?.path).toBe('rules.1.capMinor');
    // (2 000 + 1 000) at 20% → 15 000.
    expect(issues.find((i) => i.code === 'FIXED_BREAK_EVEN')?.message).toMatch(/15000/);
  });

  it('requires policies:auto-approve to publish a policy that skips approval', () => {
    const d = draft({ requiresApproval: false });
    const blocked = validatePolicy(d, { ...ctx, canAutoApprove: false });
    expect(blocked.find((i) => i.code === 'AUTO_APPROVE_FORBIDDEN')?.severity).toBe('error');
    expect(validatePolicy(d, { ...ctx, canAutoApprove: false, forPublish: false }).find((i) => i.code === 'AUTO_APPROVE_FORBIDDEN')?.severity).toBe(
      'warning',
    );
    const allowed = validatePolicy(d, { ...ctx, canAutoApprove: true });
    expect(hasErrors(allowed)).toBe(false);
    expect(allowed.some((i) => i.code === 'AUTO_APPROVE')).toBe(true);
  });
});

describe('breakEvenSaleMinor', () => {
  it('matches the calculator rounding at the boundary', () => {
    // MONEY: 1 001 at 30% → base ≥ ceil(1 001 × 10 000 / 3 000) = 3 337 (floor(3 337 × 0.3) = 1 001).
    expect(breakEvenSaleMinor(1_001n, 3000, { rewardUnit: 'MONEY', currencyMinorUnits: 2, pointsPerCurrencyUnit: 1 })).toBe(3_337n);
    // POINTS: 7 points at 10% → base ≥ 70; 3 points per unit, 2 minor units → sale ≥ ceil(7 000 / 3) = 2 334.
    expect(breakEvenSaleMinor(7n, 1000, { rewardUnit: 'POINTS', currencyMinorUnits: 2, pointsPerCurrencyUnit: 3 })).toBe(2_334n);
    expect(breakEvenSaleMinor(0n, 1000, { rewardUnit: 'MONEY', currencyMinorUnits: 2, pointsPerCurrencyUnit: 1 })).toBeNull();
  });
});
