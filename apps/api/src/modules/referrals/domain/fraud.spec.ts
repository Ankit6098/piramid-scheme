import { describe, expect, it } from 'vitest';
import { isSharedIpSuspicious, sharedIpDedupeKey, sharedIpFlagDetails } from './fraud';

describe('shared-IP heuristic', () => {
  it('flags from the third attribution', () => {
    expect(isSharedIpSuspicious(2)).toBe(false);
    expect(isSharedIpSuspicious(3)).toBe(true);
  });
  it('builds the documented dedupe key', () => {
    expect(sharedIpDedupeKey('s-1', '203.0.113.7')).toBe('SHARED_IP:s-1:203.0.113.7');
    expect(sharedIpDedupeKey('s-1', '2001:db8::1')).toBe('SHARED_IP:s-1:2001:db8::1');
  });
  it('explains the signal without promising consequences', () => {
    const text = sharedIpFlagDetails(4, '203.0.113.7', new Date('2026-10-10T08:00:00Z'));
    expect(text).toContain('4 registrations');
    expect(text).toContain('203.0.113.7');
    expect(text).toContain('Advisory only');
  });
});
