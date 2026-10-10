import { toJsonValue } from '../http/json-safe';
import { looksLikeEmail, maskEmail, maskPhone } from './mask';

/**
 * Keys never written to audit logs, compared case-insensitively at any depth. The database rejects
 * audit rows whose before/after contain any of the first group (CHECK ck_audit_logs_no_secrets), so
 * they MUST be removed before insert; the rest are app-level extras.
 * Note: `code` alone is allowed (program codes, referral codes) — never put OTP codes in audit data.
 */
export const FORBIDDEN_AUDIT_KEYS: readonly string[] = [
  // mirrored by the DB CHECK (with optional "_" separators)
  'password',
  'passwordHash',
  'token',
  'tokenHash',
  'otp',
  'otpCode',
  'codeHash',
  'secret',
  'secretEnc',
  'sessionToken',
  'csrfToken',
  'apiKey',
  'keyHash',
  'codeCiphertext',
  // app-level extras
  'newPassword',
  'currentPassword',
  'pendingPasswordHash',
  'otpPepper',
  'totpSecret',
  'mfaSecret',
  'requestHash',
];

/** Same pattern as the DB CHECK, anchored to a whole key. */
const DB_FORBIDDEN_KEY =
  /^(password|password_?hash|token|token_?hash|otp|otp_?code|code_?hash|secret|secret_?enc|session_?token|csrf_?token|api_?key|key_?hash|code_?ciphertext)$/i;
/** Defensive catch-all for secret-looking names (e.g. `newPassword`, `pepper`, `refreshToken`). */
const SECRETISH_KEY = /(password|secret|ciphertext|pepper)|(token|hash)$/i;

const FORBIDDEN = new Set(FORBIDDEN_AUDIT_KEYS.map((k) => k.toLowerCase()));

export function isForbiddenAuditKey(key: string): boolean {
  return FORBIDDEN.has(key.toLowerCase()) || DB_FORBIDDEN_KEY.test(key) || SECRETISH_KEY.test(key);
}

/**
 * Recursively removes secret-looking keys and masks PII: values of keys ending in `email` are masked
 * with `maskEmail`, keys ending in `phone` with `maskPhone`. Input is first converted to JSON-safe data
 * (bigint → string, Date → ISO). Callers should still pass an explicit allow-list of changed fields.
 */
export function redactForAudit(value: unknown): unknown {
  return strip(toJsonValue(value));
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isForbiddenAuditKey(k)) continue;
      if (/email$/i.test(k) && looksLikeEmail(v)) out[k] = maskEmail(v);
      else if (/phone$/i.test(k) && typeof v === 'string') out[k] = maskPhone(v);
      else out[k] = strip(v);
    }
    return out;
  }
  return value;
}
