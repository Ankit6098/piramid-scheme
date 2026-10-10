import { describe, expect, it } from 'vitest';
import { buildEarningsBuckets, calendarDate } from './member-view';

describe('calendarDate', () => {
  it('formats the calendar date in the program zone', () => {
    const late = new Date('2026-10-09T20:00:00.000Z'); // 01:30 on the 10th in Kolkata
    expect(calendarDate(late, 'Asia/Kolkata')).toBe('2026-10-10');
    expect(calendarDate(late, 'UTC')).toBe('2026-10-09');
    expect(calendarDate(late, 'America/New_York')).toBe('2026-10-09');
  });

  it('handles null and unknown zones', () => {
    expect(calendarDate(null, 'UTC')).toBeNull();
    expect(calendarDate(new Date('2026-01-02T03:04:05Z'), 'Not/AZone')).toBe('2026-01-02');
  });
});

describe('buildEarningsBuckets', () => {
  const minor = new Map([
    ['INR', 2],
    ['USD', 2],
  ]);

  it('earned = credits − debits; pending and reversed from rewards; rejected never totalled', () => {
    const buckets = buildEarningsBuckets(
      [{ rewardUnit: 'MONEY', currencyCode: 'INR', creditsMinor: 15_000n, debitsMinor: 5_000n }],
      [
        { rewardUnit: 'MONEY', currencyCode: 'INR', status: 'POSTED', amountMinor: 10_000n, count: 1 },
        { rewardUnit: 'MONEY', currencyCode: 'INR', status: 'REVERSED', amountMinor: 5_000n, count: 1 },
        { rewardUnit: 'MONEY', currencyCode: 'INR', status: 'PENDING_APPROVAL', amountMinor: 700n, count: 2 },
        { rewardUnit: 'MONEY', currencyCode: 'INR', status: 'APPROVED', amountMinor: 300n, count: 1 },
        { rewardUnit: 'MONEY', currencyCode: 'INR', status: 'REJECTED', amountMinor: 99_999n, count: 4 },
      ],
      minor,
    );
    expect(buckets).toEqual([
      {
        rewardUnit: 'MONEY',
        currencyCode: 'INR',
        currencyMinorUnits: 2,
        earnedToDateMinor: '10000',
        pendingMinor: '1000',
        reversedMinor: '5000',
        postedCount: 1,
        pendingCount: 3,
        reversedCount: 1,
      },
    ]);
  });

  it('keeps separate buckets per unit and currency, sorted', () => {
    const buckets = buildEarningsBuckets(
      [
        { rewardUnit: 'POINTS', currencyCode: 'INR', creditsMinor: 50n, debitsMinor: 0n },
        { rewardUnit: 'MONEY', currencyCode: 'USD', creditsMinor: 100n, debitsMinor: 0n },
      ],
      [{ rewardUnit: 'MONEY', currencyCode: 'INR', status: 'PENDING_APPROVAL', amountMinor: 10n, count: 1 }],
      minor,
    );
    expect(buckets.map((b) => [b.rewardUnit, b.currencyCode, b.earnedToDateMinor, b.pendingMinor])).toEqual([
      ['MONEY', 'INR', '0', '10'],
      ['MONEY', 'USD', '100', '0'],
      ['POINTS', 'INR', '50', '0'],
    ]);
  });

  it('omits buckets that only hold rejected rewards', () => {
    expect(
      buildEarningsBuckets([], [{ rewardUnit: 'MONEY', currencyCode: 'INR', status: 'REJECTED', amountMinor: 10n, count: 1 }], minor),
    ).toEqual([]);
  });
});
