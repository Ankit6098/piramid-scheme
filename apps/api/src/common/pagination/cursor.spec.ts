import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../errors/app-error';
import { decodeCursor, encodeCursor, paginate } from './cursor';

const schema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });
const key = { createdAt: '2026-10-01T10:00:00.000Z', id: '6f1b0b8e-5d2a-4f43-9a51-0d3f1b2c4e5f' };

describe('cursor encode/decode', () => {
  it('round-trips through base64url JSON', () => {
    const c = encodeCursor(key);
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(c, schema)).toEqual(key);
  });

  it('returns undefined for absent cursors', () => {
    expect(decodeCursor(undefined, schema)).toBeUndefined();
    expect(decodeCursor(null, schema)).toBeUndefined();
    expect(decodeCursor('', schema)).toBeUndefined();
  });

  it.each([
    ['not base64url', 'abc$%^'],
    ['not JSON', Buffer.from('{oops').toString('base64url')],
    ['wrong shape', encodeCursor({ createdAt: 'yesterday', id: 1 })],
    ['too long', 'a'.repeat(600)],
  ])('rejects %s with 400 VALIDATION_FAILED', (_label, cursor) => {
    let caught: unknown;
    try {
      decodeCursor(cursor, schema);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('VALIDATION_FAILED');
    expect((caught as AppError).httpStatus).toBe(400);
  });
});

describe('paginate', () => {
  const rows = [1, 2, 3].map((n) => ({ id: `id-${n}`, n }));

  it('emits nextCursor from the last row of a full page (rows fetched with limit + 1)', () => {
    const page = paginate(rows, 2, (r) => ({ id: r.id }), (r) => r.n);
    expect(page.data).toEqual([1, 2]);
    expect(page.page.limit).toBe(2);
    expect(decodeCursor(page.page.nextCursor, z.object({ id: z.string() }))).toEqual({ id: 'id-2' });
  });

  it('has a null nextCursor on the last page', () => {
    const page = paginate(rows, 3, (r) => r.id);
    expect(page).toEqual({ data: rows, page: { nextCursor: null, limit: 3 } });
    expect(paginate([], 10, () => 'x')).toEqual({ data: [], page: { nextCursor: null, limit: 10 } });
  });
});
