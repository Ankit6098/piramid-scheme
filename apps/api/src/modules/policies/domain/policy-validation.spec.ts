import { describe, expect, it } from 'vitest';
import { hasErrors, validatePolicy, type PolicyContext, type PolicyDraft } from './policy-validation';

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
});
