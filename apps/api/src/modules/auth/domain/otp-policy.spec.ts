import { describe, expect, it } from 'vitest';
import {
  dayBucket,
  decideSend,
  failedAttemptsOf,
  isBlocked,
  OTP_POLICY,
  summarizeHistory,
  type ChallengeHistoryRow,
} from './otp-policy';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;

function row(createdAgoMs: number, attempts = 0, consumed = false): ChallengeHistoryRow {
  return { createdAt: ago(createdAgoMs), attempts, consumedAt: consumed ? ago(createdAgoMs - 1000) : null };
}

describe('otp policy', () => {
  it('counts failed attempts, excluding the successful attempt of a consumed code', () => {
    expect(failedAttemptsOf(row(0, 3, false))).toBe(3);
    expect(failedAttemptsOf(row(0, 3, true))).toBe(2);
    expect(failedAttemptsOf(row(0, 0, true))).toBe(0);
  });

  it('summarizes sends in the last hour and failures in the last 24 h', () => {
    const s = summarizeHistory([row(5 * MIN, 2), row(50 * MIN, 5), row(2 * HOUR, 4), row(25 * HOUR, 5)], NOW);
    expect(s.sendsLastHour).toBe(2);
    expect(s.failedInWindow).toBe(11);
    expect(s.lastSentAt).toEqual(ago(5 * MIN));
    expect(s.oldestFailureAt).toEqual(ago(2 * HOUR));
    expect(isBlocked(s)).toBe(true);
  });

  it('allows a send with an empty history', () => {
    expect(decideSend(summarizeHistory([], NOW), NOW)).toEqual({ allowed: true });
  });

  it('enforces the 60 s cooldown unless told not to', () => {
    const s = summarizeHistory([row(20_000)], NOW);
    expect(decideSend(s, NOW)).toEqual({ allowed: false, reason: 'COOLDOWN', retryAfterSeconds: 40 });
    expect(decideSend(s, NOW, { enforceCooldown: false })).toEqual({ allowed: true });
    expect(decideSend(summarizeHistory([row(61_000)], NOW), NOW)).toEqual({ allowed: true });
  });

  it('enforces the hourly cap (even without cooldown) with a Retry-After from the oldest send', () => {
    const rows = [row(2 * MIN), row(10 * MIN), row(20 * MIN), row(30 * MIN), row(40 * MIN)];
    const d = decideSend(summarizeHistory(rows, NOW), NOW, { enforceCooldown: false });
    expect(d).toEqual({ allowed: false, reason: 'HOURLY_CAP', retryAfterSeconds: 20 * 60 });
  });

  it('blocks for 24 h after 10 failed attempts', () => {
    const rows = [row(3 * HOUR, 5), row(2 * HOUR, 5)];
    const d = decideSend(summarizeHistory(rows, NOW), NOW);
    expect(d).toMatchObject({ allowed: false, reason: 'BLOCKED' });
    expect(d.allowed === false && d.retryAfterSeconds).toBe(21 * 3600);
    // 9 failures are not enough
    expect(isBlocked(summarizeHistory([row(HOUR, 5), row(HOUR, 4)], NOW))).toBe(false);
    // failures older than the window do not count
    expect(isBlocked(summarizeHistory([row(25 * HOUR, 5), row(26 * HOUR, 5)], NOW))).toBe(false);
  });

  it('uses the documented defaults', () => {
    expect(OTP_POLICY).toMatchObject({ ttlMs: 600_000, maxAttempts: 5, cooldownMs: 60_000, hourlySendCap: 5, failedCap: 10 });
    expect(dayBucket(NOW)).toBe(dayBucket(new Date('2026-10-10T23:59:59.999Z')));
  });
});
