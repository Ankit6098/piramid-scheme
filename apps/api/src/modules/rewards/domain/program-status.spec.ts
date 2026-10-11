import { describe, expect, it } from 'vitest';
import { statusInForce, type ProgramStatusChangeRow } from './program-status';

const at = (s: number) => new Date(Date.UTC(2026, 9, 10, 12, 0, s));
const row = (fromStatus: ProgramStatusChangeRow['fromStatus'], toStatus: ProgramStatusChangeRow['toStatus'], s: number) => ({
  fromStatus,
  toStatus,
  changedAt: at(s),
});

describe('statusInForce', () => {
  it('is null before any change and the newest status otherwise', () => {
    expect(statusInForce([])).toBeNull();
    expect(statusInForce([row('ACTIVE', 'PAUSED', 5), row('DRAFT', 'ACTIVE', 3), row(null, 'DRAFT', 1)])).toBe('PAUSED');
  });

  it('resolves changes that share one timestamp (one transaction) to the end of the chain, in any order', () => {
    expect(statusInForce([row(null, 'DRAFT', 1), row('DRAFT', 'ACTIVE', 1)])).toBe('ACTIVE');
    expect(statusInForce([row('DRAFT', 'ACTIVE', 1), row(null, 'DRAFT', 1)])).toBe('ACTIVE');
    expect(statusInForce([row('ACTIVE', 'COMPLETED', 1), row(null, 'DRAFT', 1), row('DRAFT', 'ACTIVE', 1)])).toBe('COMPLETED');
    expect(statusInForce([row(null, 'DRAFT', 2), row('DRAFT', 'ACTIVE', 2), row('ACTIVE', 'PAUSED', 1)])).toBe('ACTIVE');
  });
});
