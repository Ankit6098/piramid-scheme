import { describe, expect, it } from 'vitest';
import { loginBackoffMs, normalizeThrottleIp } from './login-throttle.service';

describe('loginBackoffMs', () => {
  it('is free below the threshold, then 30 s doubling up to the 15 min cap', () => {
    const b = (n: number) => loginBackoffMs(n, 5, 30_000, 900_000);
    expect([0, 1, 4].map(b)).toEqual([0, 0, 0]);
    expect(b(5)).toBe(30_000);
    expect(b(6)).toBe(60_000);
    expect(b(7)).toBe(120_000);
    expect(b(9)).toBe(480_000);
    expect(b(10)).toBe(900_000);
    expect(b(500)).toBe(900_000);
  });
});

describe('normalizeThrottleIp', () => {
  it('normalizes IPv4, IPv4-mapped and IPv6 addresses', () => {
    expect(normalizeThrottleIp('203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeThrottleIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeThrottleIp('2001:db8:85a3:0042:1000:8a2e:0370:7334')).toBe('2001:db8:85a3:42::/64');
    expect(normalizeThrottleIp('2001:DB8:85A3:42::1')).toBe('2001:db8:85a3:42::/64');
    expect(normalizeThrottleIp('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(normalizeThrottleIp('::1')).toBe('0:0:0:0::/64');
    expect(normalizeThrottleIp(null)).toBe('unknown');
    expect(normalizeThrottleIp('')).toBe('unknown');
  });
});
