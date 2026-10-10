import { randomInt } from 'node:crypto';

/** Crockford-style alphabet without the ambiguous 0/O/1/I/L (business rules §6). */
export const REFERRAL_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const REFERRAL_CODE_LENGTH = 8;

/** Generates a random global referral code. `pick` is injectable for tests. */
export function generateReferralCode(pick: (max: number) => number = randomInt): string {
  let code = '';
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i += 1) {
    code += REFERRAL_CODE_ALPHABET[pick(REFERRAL_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * Normalizes user input ("  ab-cd 2345 ") to the stored form ("ABCD2345"). Returns null when the
 * result cannot be a valid code (DB format: ^[A-Z0-9]{6,16}$).
 */
export function normalizeReferralCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z0-9]{6,16}$/.test(code) ? code : null;
}
