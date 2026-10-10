import { describe, expect, it } from 'vitest';
import {
  buildDailySeries,
  checkAdminPasswordReset,
  checkStatusChange,
  diffRoles,
  escapeLike,
  firstNameOf,
  mergeRewardSummary,
  normalizeRoles,
  seriesStart,
  utcDayKey,
} from './admin-rules';

const superAdmin = { userId: 'sa', roles: ['MEMBER', 'SUPER_ADMIN'] };
const financeWithWrite = { userId: 'fr', roles: ['MEMBER', 'FINANCE_REVIEWER'] };

describe('checkStatusChange', () => {
  it('refuses self-targeting', () => {
    expect(checkStatusChange(superAdmin, { id: 'sa', roles: ['MEMBER'], status: 'ACTIVE' }, 'suspend')).toEqual({
      allowed: false,
      reason: 'SELF',
    });
  });

  it('only lets a SUPER_ADMIN act on admins', () => {
    const admin = { id: 'pa', roles: ['MEMBER', 'PROGRAM_ADMIN'], status: 'ACTIVE' as const };
    expect(checkStatusChange(financeWithWrite, admin, 'suspend')).toEqual({ allowed: false, reason: 'ADMIN_TARGET' });
    expect(checkStatusChange(superAdmin, admin, 'suspend')).toEqual({ allowed: true });
    expect(checkStatusChange(financeWithWrite, { id: 'm', roles: ['MEMBER'], status: 'ACTIVE' }, 'suspend')).toEqual({ allowed: true });
  });

  it('requires ACTIVE to suspend and SUSPENDED to reactivate', () => {
    const member = (status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED') => ({ id: 'm', roles: ['MEMBER'], status });
    expect(checkStatusChange(superAdmin, member('SUSPENDED'), 'suspend')).toEqual({ allowed: false, reason: 'INVALID_STATUS' });
    expect(checkStatusChange(superAdmin, member('ACTIVE'), 'reactivate')).toEqual({ allowed: false, reason: 'INVALID_STATUS' });
    expect(checkStatusChange(superAdmin, member('DEACTIVATED'), 'reactivate')).toEqual({ allowed: false, reason: 'INVALID_STATUS' });
    expect(checkStatusChange(superAdmin, member('SUSPENDED'), 'reactivate')).toEqual({ allowed: true });
  });
});

describe('checkAdminPasswordReset', () => {
  const member = (status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED' = 'ACTIVE') => ({ id: 'm', status });

  it('is a SUPER_ADMIN action, for another account', () => {
    expect(checkAdminPasswordReset(superAdmin, member())).toEqual({ allowed: true });
    expect(checkAdminPasswordReset(superAdmin, { id: 'pa', status: 'ACTIVE' })).toEqual({ allowed: true });
    expect(checkAdminPasswordReset(financeWithWrite, member())).toEqual({ allowed: false, reason: 'NOT_SUPER_ADMIN' });
    expect(checkAdminPasswordReset({ userId: 'pa', roles: ['MEMBER', 'PROGRAM_ADMIN'] }, member())).toEqual({
      allowed: false,
      reason: 'NOT_SUPER_ADMIN',
    });
    expect(checkAdminPasswordReset(superAdmin, { id: 'sa', status: 'ACTIVE' })).toEqual({ allowed: false, reason: 'SELF' });
  });

  it('requires an ACTIVE target', () => {
    expect(checkAdminPasswordReset(superAdmin, member('SUSPENDED'))).toEqual({ allowed: false, reason: 'INVALID_STATUS' });
    expect(checkAdminPasswordReset(superAdmin, member('DEACTIVATED'))).toEqual({ allowed: false, reason: 'INVALID_STATUS' });
  });
});

describe('roles', () => {
  it('normalizes: dedupes, always keeps MEMBER, canonical order', () => {
    expect(normalizeRoles(['FINANCE_REVIEWER', 'SUPER_ADMIN', 'FINANCE_REVIEWER'])).toEqual(['SUPER_ADMIN', 'FINANCE_REVIEWER', 'MEMBER']);
    expect(normalizeRoles([])).toEqual(['MEMBER']);
  });

  it('diffs current vs requested', () => {
    expect(diffRoles(['PROGRAM_ADMIN', 'MEMBER'], normalizeRoles(['FINANCE_REVIEWER']))).toEqual({
      granted: ['FINANCE_REVIEWER'],
      revoked: ['PROGRAM_ADMIN'],
    });
    expect(diffRoles(['MEMBER'], normalizeRoles([]))).toEqual({ granted: [], revoked: [] });
  });
});

describe('daily series', () => {
  const now = new Date('2026-10-10T18:30:00Z');

  it('starts at 00:00 UTC of the first day of the window', () => {
    expect(seriesStart(now, 30).toISOString()).toBe('2026-09-11T00:00:00.000Z');
    expect(utcDayKey(new Date('2026-10-10T23:59:59.999Z'))).toBe('2026-10-10');
  });

  it('fills every day (oldest first) and ignores keys outside the window', () => {
    const series = buildDailySeries(now, 30, {
      registrations: new Map([
        ['2026-10-10', 2],
        ['2026-09-11', 1],
        ['2026-09-10', 99],
      ]),
      sales: new Map([['2026-10-01', 5]]),
      rewardsPosted: new Map(),
    });
    expect(series).toHaveLength(30);
    expect(series[0]).toEqual({ date: '2026-09-11', registrations: 1, sales: 0, rewardsPosted: 0 });
    expect(series[29]).toEqual({ date: '2026-10-10', registrations: 2, sales: 0, rewardsPosted: 0 });
    expect(series.find((p) => p.date === '2026-10-01')?.sales).toBe(5);
    expect(series.reduce((s, p) => s + p.registrations, 0)).toBe(3);
  });
});

describe('mergeRewardSummary', () => {
  it('buckets per unit/currency: earned from the ledger, pending = pending + approved, reversed; rejected ignored', () => {
    const result = mergeRewardSummary(
      [
        { rewardUnit: 'MONEY', currencyCode: 'INR', balanceMinor: 1500n },
        { rewardUnit: 'POINTS', currencyCode: 'INR', balanceMinor: 0n },
      ],
      [
        { rewardUnit: 'MONEY', currencyCode: 'INR', status: 'PENDING_APPROVAL', amountMinor: 100n },
        { rewardUnit: 'MONEY', currencyCode: 'INR', status: 'APPROVED', amountMinor: 50n },
        { rewardUnit: 'MONEY', currencyCode: 'INR', status: 'REVERSED', amountMinor: 700n },
        { rewardUnit: 'MONEY', currencyCode: 'INR', status: 'REJECTED', amountMinor: 999n },
        { rewardUnit: 'MONEY', currencyCode: 'INR', status: 'POSTED', amountMinor: 1500n },
        { rewardUnit: 'MONEY', currencyCode: 'USD', status: 'PENDING_APPROVAL', amountMinor: 10n },
      ],
    );
    expect(result).toEqual([
      { rewardUnit: 'MONEY', currencyCode: 'INR', earnedMinor: 1500n, pendingMinor: 150n, reversedMinor: 700n },
      { rewardUnit: 'MONEY', currencyCode: 'USD', earnedMinor: 0n, pendingMinor: 10n, reversedMinor: 0n },
    ]);
  });
});

describe('helpers', () => {
  it('firstNameOf', () => {
    expect(firstNameOf('  Anita   Sharma ')).toBe('Anita');
    expect(firstNameOf('Cher')).toBe('Cher');
  });

  it('escapeLike escapes wildcards and the escape character', () => {
    expect(escapeLike('50%_off\\x')).toBe('50\\%\\_off\\\\x');
    expect(escapeLike('plain')).toBe('plain');
  });
});
