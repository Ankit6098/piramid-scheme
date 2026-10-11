import { describe, expect, it } from 'vitest';
import { TOTP_LOCKOUT_POLICY, totpLockoutMs } from './totp-lockout';

describe('totp lockout policy', () => {
  it('locks after 10 consecutive failures for 15 min, doubling up to 24 h', () => {
    expect(TOTP_LOCKOUT_POLICY).toMatchObject({ threshold: 10, baseMs: 900_000, maxMs: 86_400_000 });
    expect(totpLockoutMs(0)).toBe(0);
    expect(totpLockoutMs(9)).toBe(0);
    expect(totpLockoutMs(10)).toBe(15 * 60_000);
    expect(totpLockoutMs(11)).toBe(30 * 60_000);
    expect(totpLockoutMs(14)).toBe(240 * 60_000);
    expect(totpLockoutMs(17)).toBe(24 * 3_600_000);
    expect(totpLockoutMs(500)).toBe(24 * 3_600_000);
  });

  it('honours a custom policy', () => {
    expect(totpLockoutMs(3, { threshold: 3, baseMs: 1000, maxMs: 5000, windowMs: 60_000 })).toBe(1000);
    expect(totpLockoutMs(6, { threshold: 3, baseMs: 1000, maxMs: 5000, windowMs: 60_000 })).toBe(5000);
  });
});
