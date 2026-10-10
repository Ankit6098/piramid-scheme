import { describe, expect, it } from 'vitest';
import { REFERRAL_CODE_ALPHABET, generateReferralCode, normalizeReferralCode } from './referral-code';

describe('referral codes', () => {
  it('generates 8 characters from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateReferralCode();
      expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
    }
    expect(REFERRAL_CODE_ALPHABET).not.toMatch(/[01OIL]/);
  });

  it('is deterministic with an injected picker', () => {
    expect(generateReferralCode(() => 0)).toBe('22222222');
  });

  it('normalizes user input', () => {
    expect(normalizeReferralCode('  ab-cd 2345 ')).toBe('ABCD2345');
    expect(normalizeReferralCode('abc')).toBeNull();
    expect(normalizeReferralCode('ABCD#234')).toBeNull();
  });
});
