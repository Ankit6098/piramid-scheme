/**
 * API keys for integration clients (business rules §8): random, prefixed for recognisability, shown
 * once and stored only as SHA-256 + a short display prefix.
 */
import { createHash, randomBytes } from 'node:crypto';
import { API_KEY_PREFIX } from '@app/shared';

/** Characters of the key kept for display (prefix + 8 random chars). */
export const API_KEY_DISPLAY_LENGTH = API_KEY_PREFIX.length + 8;
const KEY_BODY_BYTES = 32;
const KEY_RE = new RegExp(`^${API_KEY_PREFIX}[A-Za-z0-9_-]{43}$`);

export interface GeneratedApiKey {
  apiKey: string;
  keyPrefix: string;
  keyHash: string;
}

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

export function generateApiKey(): GeneratedApiKey {
  const apiKey = `${API_KEY_PREFIX}${randomBytes(KEY_BODY_BYTES).toString('base64url')}`;
  return { apiKey, keyPrefix: apiKey.slice(0, API_KEY_DISPLAY_LENGTH), keyHash: hashApiKey(apiKey) };
}

/** True when the string has the shape of a key we issue (cheap pre-check before a lookup). */
export function looksLikeApiKey(value: string): boolean {
  return KEY_RE.test(value);
}

/** Extracts the token of an `Authorization: Bearer <token>` header (null when absent/malformed). */
export function parseBearer(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(value);
  return m?.[1] ?? null;
}
