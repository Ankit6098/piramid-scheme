import { describe, expect, it } from 'vitest';
import { calculateRewards, serializeTrace, type CalcPolicy } from './reward-calculator';
import { parseRewardTrace, traceUserIds } from './trace';

const policy: CalcPolicy = {
  id: 'p1',
  version: 3,
  maxDepth: 3,
  budgetBps: 2000,
  maxTotalPerEventMinor: null,
  minEventAmountMinor: 0n,
  ineligibleAncestorBehavior: 'FORFEIT',
  roundingMode: 'HALF_UP',
  triggerEventTypes: ['PRODUCT_SALE'],
  rules: [
    { level: 1, calcType: 'PERCENTAGE', fixedAmountMinor: null, percentageBps: 1000, capMinor: null },
    { level: 2, calcType: 'FIXED', fixedAmountMinor: 500n, percentageBps: null, capMinor: null },
    { level: 3, calcType: 'PERCENTAGE', fixedAmountMinor: null, percentageBps: 500, capMinor: null },
  ],
};

describe('parseRewardTrace', () => {
  it('reads a trace written by the engine', () => {
    const ancestors = [
      { userId: 'u1', depth: 1, eligible: true },
      { userId: 'u2', depth: 2, eligible: false, ineligibleReason: 'no eligible enrollment at the sale date' },
      { userId: 'u3', depth: 3, eligible: true },
    ];
    const result = calculateRewards({
      event: { type: 'PRODUCT_SALE', amountMinor: 100_000n },
      policy,
      unit: { rewardUnit: 'MONEY', currencyMinorUnits: 2, pointsPerCurrencyUnit: 1 },
      ancestors,
    });
    const raw = JSON.parse(
      JSON.stringify(
        serializeTrace(result, {
          policyVersion: 3,
          ancestorsConsidered: ancestors.map((a) => ({ userId: a.userId, depth: a.depth, eligible: a.eligible, reason: a.ineligibleReason ?? null })),
        }),
      ),
    ) as unknown;

    const trace = parseRewardTrace(raw);
    expect(trace).toMatchObject({
      parsed: true,
      engineVersion: '1.0.0',
      saleAmountMinor: '100000',
      baseMinor: '100000',
      budgetBps: 2000,
      budgetMinor: '20000',
      totalAllocatedMinor: '15000',
      policyVersion: 3,
    });
    expect(trace.levels.map((l) => [l.level, l.decision, l.userId, l.amountMinor])).toEqual([
      [1, 'AWARDED', 'u1', '10000'],
      [2, 'INELIGIBLE_FORFEITED', 'u2', null],
      [3, 'AWARDED', 'u3', '5000'],
    ]);
    expect(trace.levels[1]!.reason).toBe('no eligible enrollment at the sale date');
    expect(trace.levels[0]).toMatchObject({ calcType: 'PERCENTAGE', percentageBps: 1000, ruleAmountMinor: '10000' });
    expect(trace.ancestors.map((a) => [a.userId, a.eligible])).toEqual([
      ['u1', true],
      ['u2', false],
      ['u3', true],
    ]);
    expect(traceUserIds(trace).sort()).toEqual(['u1', 'u2', 'u3']);
  });

  it('degrades gracefully for unknown shapes', () => {
    expect(parseRewardTrace({ test: true })).toMatchObject({ parsed: false, levels: [], ancestors: [] });
    expect(parseRewardTrace(null).parsed).toBe(false);
    expect(parseRewardTrace({ steps: [{ step: 'level', level: 'x' }, 7] })).toMatchObject({ parsed: true, levels: [] });
  });
});
