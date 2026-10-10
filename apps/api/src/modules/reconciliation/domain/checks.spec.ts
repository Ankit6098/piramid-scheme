import { ReconciliationCheckKey } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { CHECKS, summarizeChecks } from './checks';

describe('reconciliation checks catalog', () => {
  it('covers every check key exactly once', () => {
    expect(CHECKS.map((c) => c.key).sort()).toEqual([...ReconciliationCheckKey].sort());
  });

  it('is healthy with no exceptions', () => {
    const s = summarizeChecks([]);
    expect(s).toMatchObject({ totalExceptions: 0, healthy: true });
    expect(s.checks.every((c) => c.passed && c.count === 0)).toBe(true);
  });

  it('review items count but do not make the platform unhealthy', () => {
    const s = summarizeChecks([{ key: 'PLAN_PAYMENT_LOOKALIKE', count: 2, exceptions: [] }]);
    expect(s).toMatchObject({ totalExceptions: 2, healthy: true });
    expect(s.checks.find((c) => c.key === 'PLAN_PAYMENT_LOOKALIKE')).toMatchObject({ passed: false, count: 2 });
  });

  it('warnings and critical exceptions make it unhealthy', () => {
    expect(summarizeChecks([{ key: 'EVENT_STUCK_RECEIVED', count: 1, exceptions: [] }]).healthy).toBe(false);
    expect(summarizeChecks([{ key: 'UNBALANCED_TRANSACTION', count: 1, exceptions: [] }]).healthy).toBe(false);
  });
});
