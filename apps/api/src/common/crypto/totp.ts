import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) on top of HOTP (RFC 4226). Defaults: SHA-1, 6 digits, 30 s step, ±1 step window —
 * what every mainstream authenticator app supports.
 *
 * Replay protection: `verifyTotp` returns the matched time-step; persist it in
 * `user_mfa_factors.last_used_step` (with a conditional UPDATE … WHERE last_used_step IS NULL OR
 * last_used_step < $step) and pass it back as `lastUsedStep` next time, so a code can be used once.
 */

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

export interface TotpOptions {
  /** Default 6. */
  digits?: number;
  /** Default 30. */
  stepSeconds?: number;
  /** Default 'sha1'. */
  algorithm?: TotpAlgorithm;
}

const DEFAULTS = { digits: 6, stepSeconds: 30, algorithm: 'sha1' as TotpAlgorithm };

// ─── Base32 (RFC 4648, no padding) ──────────────────────────────────────────

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Decodes base32 (case-insensitive; spaces, dashes and `=` padding ignored). Throws on bad input. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** New random TOTP secret, base32-encoded (default 20 bytes = 160 bits, as recommended by RFC 4226). */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

// ─── HOTP / TOTP ────────────────────────────────────────────────────────────

function secretBytes(secret: Uint8Array | string): Buffer {
  return typeof secret === 'string' ? base32Decode(secret) : Buffer.from(secret);
}

/** RFC 4226 HOTP value for `counter`, zero-padded to `digits`. */
export function hotp(secret: Uint8Array | string, counter: number | bigint, digits = 6, algorithm: TotpAlgorithm = 'sha1'): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, secretBytes(secret)).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) | ((mac[offset + 1]! & 0xff) << 16) | ((mac[offset + 2]! & 0xff) << 8) | (mac[offset + 3]! & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, '0');
}

/** Time-step number for a unix time in milliseconds. */
export function totpStep(timeMs: number, stepSeconds = DEFAULTS.stepSeconds): number {
  return Math.floor(timeMs / 1000 / stepSeconds);
}

/** TOTP code at `timeMs` (default now). */
export function totp(secret: Uint8Array | string, timeMs = Date.now(), options: TotpOptions = {}): string {
  const o = { ...DEFAULTS, ...options };
  return hotp(secret, totpStep(timeMs, o.stepSeconds), o.digits, o.algorithm);
}

export interface VerifyTotpOptions extends TotpOptions {
  /** Unix ms (default Date.now()). */
  now?: number;
  /** Accepted drift in steps on each side (default 1 → ±30 s). */
  window?: number;
  /** Last step accepted for this factor; any step ≤ it is rejected as a replay. */
  lastUsedStep?: number | bigint | null;
}

export type VerifyTotpResult =
  | { ok: true; /** Matched time-step — persist as last_used_step. */ step: number }
  | { ok: false; reason: 'malformed' | 'invalid' | 'replayed' };

/**
 * Verifies a user-entered code. Every candidate step in the window is computed and compared in
 * constant time (no early exit). Returns the matched step, or why it failed.
 */
export function verifyTotp(secret: Uint8Array | string, code: string, options: VerifyTotpOptions = {}): VerifyTotpResult {
  const o = { ...DEFAULTS, ...options };
  const window = options.window ?? 1;
  const normalized = typeof code === 'string' ? code.replace(/\s/g, '') : '';
  if (!new RegExp(`^\\d{${o.digits}}$`).test(normalized)) return { ok: false, reason: 'malformed' };
  const key = secretBytes(secret);
  const current = totpStep(options.now ?? Date.now(), o.stepSeconds);
  const last = options.lastUsedStep === null || options.lastUsedStep === undefined ? null : Number(options.lastUsedStep);
  const given = Buffer.from(normalized, 'utf8');
  let matched: number | null = null;
  let replayed = false;
  for (let s = current - window; s <= current + window; s++) {
    if (s < 0) continue;
    const candidate = Buffer.from(hotp(key, s, o.digits, o.algorithm), 'utf8');
    if (timingSafeEqual(candidate, given)) {
      if (last !== null && s <= last) replayed = true;
      else matched = matched === null ? s : Math.max(matched, s);
    }
  }
  if (matched !== null) return { ok: true, step: matched };
  return { ok: false, reason: replayed ? 'replayed' : 'invalid' };
}

export interface OtpauthUriInput {
  /** Base32 secret. */
  secret: string;
  /** Usually the user's email address. */
  accountName: string;
  /** Product name shown in the authenticator app. */
  issuer: string;
  digits?: number;
  period?: number;
  algorithm?: TotpAlgorithm;
}

/**
 * `otpauth://totp/Issuer:account?secret=…&issuer=…&algorithm=SHA1&digits=6&period=30`
 * (Key Uri Format used by Google Authenticator & co). Render it as a QR code in the browser only.
 */
export function buildOtpauthUri(input: OtpauthUriInput): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.accountName)}`;
  const params = new URLSearchParams({
    secret: input.secret.replace(/=+$/, ''),
    issuer: input.issuer,
    algorithm: (input.algorithm ?? DEFAULTS.algorithm).toUpperCase(),
    digits: String(input.digits ?? DEFAULTS.digits),
    period: String(input.period ?? DEFAULTS.stepSeconds),
  });
  return `otpauth://totp/${label}?${params.toString().replace(/\+/g, '%20')}`;
}
