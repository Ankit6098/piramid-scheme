/**
 * RFC 6238 TOTP generator for e2e tests (node:crypto only): HMAC-SHA-1, 6 digits, 30 s step — the
 * parameters the API uses (apps/api/src/common/crypto/totp.ts) and puts into the otpauth:// URI.
 *
 * The API rejects a time-step that was already used for a factor (replay protection), so two sign-ins
 * of the same account within one 30 s window need different steps: use `nextTotp()` with the step the
 * previous code was generated for.
 */
import { createHmac } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

/** RFC 4648 base32 decode (case-insensitive; whitespace, dashes and `=` padding ignored). */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`Invalid base32 character "${ch}" in TOTP secret`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP value for a counter. */
export function hotp(secret: string, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, '0');
}

/** Time-step number for a unix time in ms. */
export function totpStep(timeMs = Date.now()): number {
  return Math.floor(timeMs / 1000 / TOTP_STEP_SECONDS);
}

/** TOTP code at `timeMs` (default now). */
export function totp(secret: string, timeMs = Date.now()): string {
  return hotp(secret, totpStep(timeMs));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A code for a time-step strictly after `lastStep` (waits for the next 30 s window if needed), and
 * at least `minRemainingMs` before its window closes so it is still current when the server checks
 * it (the server also accepts ±1 step, this just avoids edge cases). Returns the code and its step.
 */
export async function nextTotp(
  secret: string,
  lastStep: number | null = null,
  minRemainingMs = 3_000,
): Promise<{ code: string; step: number }> {
  for (;;) {
    const now = Date.now();
    const step = totpStep(now);
    const remaining = (step + 1) * TOTP_STEP_SECONDS * 1000 - now;
    if ((lastStep === null || step > lastStep) && remaining >= minRemainingMs) {
      return { code: hotp(secret, step), step };
    }
    await sleep(Math.min(remaining + 50, TOTP_STEP_SECONDS * 1000));
  }
}

/** Extracts the base32 secret from an otpauth:// URI (or returns the input if it is a bare secret). */
export function secretFromOtpauth(uriOrSecret: string): string {
  const trimmed = uriOrSecret.trim();
  if (!trimmed.toLowerCase().startsWith('otpauth://')) return trimmed.replace(/\s+/g, '');
  const secret = new URL(trimmed).searchParams.get('secret');
  if (!secret) throw new Error('otpauth URI has no secret parameter');
  return secret;
}
