/**
 * Explicit JSON serialization helpers. Amounts are `bigint` everywhere in the API and must leave the
 * process as decimal strings ("150000"). We never patch `BigInt.prototype.toJSON` — a forgotten
 * conversion should be handled here, in one visible place.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-converts a value into something `JSON.stringify` can handle without loss:
 * - bigint → decimal string
 * - Date → kept (serialized by JSON as ISO-8601)
 * - plain objects / arrays → copied recursively; `undefined` object members are dropped
 * - Map → plain object, Set → array
 * - other class instances (Buffer, StreamableFile, Decimal, …) → returned untouched
 */
export function toJsonSafe(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (seen.has(value)) throw new TypeError('Cannot serialize a circular structure');
  if (Array.isArray(value)) {
    seen.add(value);
    const out = value.map((v) => toJsonSafe(v, seen));
    seen.delete(value);
    return out;
  }
  if (value instanceof Set) return toJsonSafe([...value], seen);
  if (value instanceof Map) return toJsonSafe(Object.fromEntries(value), seen);
  if (!isPlainObject(value)) return value;
  seen.add(value);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    out[k] = toJsonSafe(v, seen);
  }
  seen.delete(value);
  return out;
}

/** `JSON.stringify` replacer used as express' `json replacer` — a backstop for bigint. */
export function bigintJsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Converts a value to JSON-compatible data for storage in a Prisma `Json` column (audit, outbox):
 * bigint → string, Date → ISO string, drops undefined.
 */
export function toJsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(toJsonSafe(value) ?? null)) as unknown;
}
