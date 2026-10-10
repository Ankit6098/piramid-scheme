import { createHash } from 'node:crypto';

/**
 * Deterministic JSON: object keys sorted, `undefined` members dropped, bigint → decimal string,
 * Date → ISO-8601. Two semantically equal requests always produce the same text.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : normalize(v)));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = normalize(v);
    }
    return out;
  }
  return value;
}

/** SHA-256 hex (64 chars) of the canonical JSON of `value` — e.g. `{ method, route, params, query, body }`. */
export function computeRequestHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}
