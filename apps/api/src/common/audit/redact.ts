import { toJsonValue } from '../http/json-safe';

/** Keys never written to audit logs (compared case-insensitively, at any depth). */
export const FORBIDDEN_AUDIT_KEYS: readonly string[] = [
  'password',
  'passwordHash',
  'newPassword',
  'currentPassword',
  'code',
  'codeHash',
  'token',
  'tokenHash',
  'otp',
  'otpPepper',
  'secret',
];

const FORBIDDEN = new Set(FORBIDDEN_AUDIT_KEYS.map((k) => k.toLowerCase()));

/** Recursively removes forbidden keys. Input is first converted to JSON-safe data (bigint → string). */
export function redactForAudit(value: unknown): unknown {
  return strip(toJsonValue(value));
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN.has(k.toLowerCase())) continue;
      out[k] = strip(v);
    }
    return out;
  }
  return value;
}
