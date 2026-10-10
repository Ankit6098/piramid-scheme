/**
 * Pure helpers that turn an audit entry's `before` / `after` snapshots (allow-listed, already
 * redacted JSON — business rules §13) into a readable list of field changes for the admin UI.
 */
import type { AuditFieldChangeDto } from '@app/shared';

/** Nested objects deeper than this are compared as a whole (keeps diffs readable and bounded). */
export const MAX_DIFF_DEPTH = 4;
/** Hard cap on the number of reported changes. */
export const MAX_DIFF_CHANGES = 200;

type Json = unknown;

function isPlainObject(value: Json): value is Record<string, Json> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isContainer(value: Json): value is Record<string, Json> | Json[] {
  return value !== null && typeof value === 'object';
}

/** Structural equality for JSON values (key order independent). */
export function jsonEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  }
  const ao = a as Record<string, Json>;
  const bo = b as Record<string, Json>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    if (!jsonEqual(ao[k], bo[k])) return false;
  }
  return true;
}

function childKeys(value: Record<string, Json> | Json[]): string[] {
  return Array.isArray(value) ? value.map((_, i) => String(i)) : Object.keys(value);
}

function childAt(value: Json, key: string): Json {
  if (Array.isArray(value)) return value[Number(key)];
  if (isPlainObject(value)) return value[key];
  return undefined;
}

/**
 * Field-level changes between two snapshots. Objects/arrays present on both sides are walked
 * recursively (dotted paths, array indexes as segments) up to `MAX_DIFF_DEPTH`; scalars and
 * type changes are reported as a single change. `undefined` on one side ⇒ added/removed.
 * Non-object snapshots (rare) are compared as one `(value)` field.
 */
export function diffAudit(before: Json, after: Json): AuditFieldChangeDto[] {
  const changes: AuditFieldChangeDto[] = [];
  const b = before ?? undefined;
  const a = after ?? undefined;

  const push = (path: string, from: Json, to: Json) => {
    if (changes.length >= MAX_DIFF_CHANGES) return;
    const kind: AuditFieldChangeDto['kind'] = from === undefined ? 'added' : to === undefined ? 'removed' : 'changed';
    changes.push({ path, kind, before: from === undefined ? null : from, after: to === undefined ? null : to });
  };

  const walk = (path: string, from: Json, to: Json, depth: number) => {
    if (jsonEqual(from, to)) return;
    const bothContainers =
      isContainer(from) && isContainer(to) && Array.isArray(from) === Array.isArray(to) && depth < MAX_DIFF_DEPTH;
    if (!bothContainers) {
      push(path, from, to);
      return;
    }
    const keys = Array.from(new Set([...childKeys(from), ...childKeys(to)]));
    if (!Array.isArray(from)) keys.sort();
    for (const key of keys) {
      walk(path ? `${path}.${key}` : key, childAt(from, key), childAt(to, key), depth + 1);
    }
  };

  if (b === undefined && a === undefined) return changes;
  if ((b === undefined || isPlainObject(b)) && (a === undefined || isPlainObject(a))) {
    const from = (b ?? {}) as Record<string, Json>;
    const to = (a ?? {}) as Record<string, Json>;
    const keys = Array.from(new Set([...Object.keys(from), ...Object.keys(to)])).sort();
    for (const key of keys) walk(key, from[key], to[key], 1);
    return changes;
  }
  walk('(value)', b, a, MAX_DIFF_DEPTH);
  return changes;
}

/** Sorted top-level keys present in either snapshot (list view summary). */
export function changedFieldsOf(before: Json, after: Json): string[] {
  const keys = new Set<string>();
  if (isPlainObject(before)) Object.keys(before).forEach((k) => keys.add(k));
  if (isPlainObject(after)) Object.keys(after).forEach((k) => keys.add(k));
  return [...keys].sort();
}
