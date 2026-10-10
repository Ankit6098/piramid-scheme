import { createHmac, timingSafeEqual } from 'node:crypto';

/** Hex HMAC-SHA-256 (64 chars). */
export function hmacSha256Hex(key: string | Buffer, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('hex');
}

/**
 * THE hash stored in `email_challenges.code_hash` (business rules §2):
 * HMAC-SHA-256(OTP_PEPPER, `${purpose}:${email}:${code}`), with the email normalized
 * (trim + lower-case). The auth slice must use this helper for both storing and verifying, and the
 * OTP email worker uses it to detect stale ciphertexts (a re-issued code).
 */
export function otpCodeHash(pepper: string, purpose: string, email: string, code: string): string {
  return hmacSha256Hex(pepper, `${purpose}:${email.trim().toLowerCase()}:${code}`);
}

/**
 * Pseudonymous, keyed identifier of an email address for rate-limit keys and similar counters
 * (never reversible without the pepper; domain-separated from OTP hashes).
 */
export function emailHmac(pepper: string, email: string, domain = 'login-throttle'): string {
  return hmacSha256Hex(pepper, `${domain}:${email.trim().toLowerCase()}`);
}

/** Constant-time comparison of two hex digests (false when lengths differ or input is not hex). */
export function hexDigestEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length !== b.length || !/^[0-9a-fA-F]+$/.test(a) || !/^[0-9a-fA-F]+$/.test(b)) return false;
  const ab = Buffer.from(a.toLowerCase(), 'hex');
  const bb = Buffer.from(b.toLowerCase(), 'hex');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
