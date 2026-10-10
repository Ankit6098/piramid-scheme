import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** Hex SHA-256 (64 chars) — used for session token hashes. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Cryptographically random opaque token, base64url (32 bytes → 43 chars). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time string comparison (false for different lengths or empty values). */
export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Alias of `safeEqual` — constant-time string comparison. */
export const constantTimeEqual = safeEqual;

/** 6-digit numeric one-time code from a CSPRNG (uniform, leading zeros kept). */
export function randomNumericCode(digits = 6): string {
  let out = '';
  for (let i = 0; i < digits; i++) out += randomInt(10).toString();
  return out;
}
