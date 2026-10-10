import { describe, expect, it } from 'vitest';
import { changedFieldsOf, diffAudit, jsonEqual, MAX_DIFF_CHANGES } from './audit-diff';

describe('jsonEqual', () => {
  it('compares JSON structurally, ignoring key order', () => {
    expect(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual({ a: null }, { a: undefined })).toBe(false);
    expect(jsonEqual({}, [])).toBe(false);
    expect(jsonEqual('1', 1)).toBe(false);
  });
});

describe('diffAudit', () => {
  it('reports changed, added and removed top-level fields in key order', () => {
    expect(diffAudit({ status: 'ACTIVE', reason: 'x' }, { status: 'SUSPENDED', suspendedAt: '2026-10-10' })).toEqual([
      { path: 'reason', kind: 'removed', before: 'x', after: null },
      { path: 'status', kind: 'changed', before: 'ACTIVE', after: 'SUSPENDED' },
      { path: 'suspendedAt', kind: 'added', before: null, after: '2026-10-10' },
    ]);
  });

  it('treats a missing before/after as an empty object (create / delete entries)', () => {
    expect(diffAudit(null, { name: 'Spring', budgetBps: 2000 })).toEqual([
      { path: 'budgetBps', kind: 'added', before: null, after: 2000 },
      { path: 'name', kind: 'added', before: null, after: 'Spring' },
    ]);
    expect(diffAudit({ name: 'Spring' }, undefined)).toEqual([{ path: 'name', kind: 'removed', before: 'Spring', after: null }]);
    expect(diffAudit(null, null)).toEqual([]);
  });

  it('walks nested objects and arrays with dotted paths and skips equal values', () => {
    const before = { roles: ['MEMBER'], rules: [{ level: 1, bps: 1000 }], meta: { a: 1, b: 2 } };
    const after = { roles: ['MEMBER', 'SUPER_ADMIN'], rules: [{ level: 1, bps: 1500 }], meta: { b: 2, a: 1 } };
    expect(diffAudit(before, after)).toEqual([
      { path: 'roles.1', kind: 'added', before: null, after: 'SUPER_ADMIN' },
      { path: 'rules.0.bps', kind: 'changed', before: 1000, after: 1500 },
    ]);
  });

  it('reports a type change as a single change', () => {
    expect(diffAudit({ v: { a: 1 } }, { v: [1] })).toEqual([{ path: 'v', kind: 'changed', before: { a: 1 }, after: [1] }]);
    expect(diffAudit({ v: null }, { v: 'x' })).toEqual([{ path: 'v', kind: 'changed', before: null, after: 'x' }]);
  });

  it('compares deep structures as a whole beyond the depth limit', () => {
    const deep = (x: number) => ({ a: { b: { c: { d: { e: x } } } } });
    expect(diffAudit(deep(1), deep(2))).toEqual([
      { path: 'a.b.c.d', kind: 'changed', before: { e: 1 }, after: { e: 2 } },
    ]);
  });

  it('handles non-object snapshots', () => {
    expect(diffAudit('old', 'new')).toEqual([{ path: '(value)', kind: 'changed', before: 'old', after: 'new' }]);
  });

  it('caps the number of changes', () => {
    const after = Object.fromEntries(Array.from({ length: MAX_DIFF_CHANGES + 50 }, (_, i) => [`k${i}`, i]));
    expect(diffAudit({}, after)).toHaveLength(MAX_DIFF_CHANGES);
  });
});

describe('changedFieldsOf', () => {
  it('returns the sorted union of top-level keys', () => {
    expect(changedFieldsOf({ status: 1, b: 2 }, { a: 1, status: 2 })).toEqual(['a', 'b', 'status']);
    expect(changedFieldsOf(null, ['x'])).toEqual([]);
  });
});
