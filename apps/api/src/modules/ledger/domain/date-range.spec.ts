import { describe, expect, it } from 'vitest';
import { parseDateBound, resolveDateRange } from './date-range';

describe('resolveDateRange', () => {
  it('returns undefined without bounds', () => {
    expect(resolveDateRange()).toBeUndefined();
  });

  it('treats calendar dates as whole UTC days', () => {
    expect(resolveDateRange('2026-10-01', '2026-10-10')).toEqual({
      gte: new Date('2026-10-01T00:00:00.000Z'),
      lt: new Date('2026-10-11T00:00:00.000Z'),
    });
  });

  it('keeps date-times as given (to is exclusive)', () => {
    expect(resolveDateRange(undefined, '2026-10-10T12:00:00+05:30')).toEqual({ lt: new Date('2026-10-10T06:30:00.000Z') });
    expect(parseDateBound('2026-10-10T00:00:00Z', 'from')).toEqual(new Date('2026-10-10T00:00:00.000Z'));
  });
});
