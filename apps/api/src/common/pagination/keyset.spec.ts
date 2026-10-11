import { describe, expect, it } from 'vitest';
import { Prisma } from '../../generated/prisma/client';
import { keysetSql, keysetWhere } from './keyset';

type Row = { createdAt: Date; id: string };
type Cond = Record<string, unknown>;

/** Tiny evaluator for the where objects keysetWhere produces (AND / OR / lt / lte / gt / gte). */
function matches(row: Row, where: Cond): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'AND') return (value as Cond[]).every((w) => matches(row, w));
    if (key === 'OR') return (value as Cond[]).some((w) => matches(row, w));
    const actual = row[key as keyof Row];
    const a = actual instanceof Date ? actual.getTime() : actual;
    return Object.entries(value as Cond).every(([op, v]) => {
      const b = v instanceof Date ? v.getTime() : (v as string | number);
      switch (op) {
        case 'lt': return a < b;
        case 'lte': return a <= b;
        case 'gt': return a > b;
        case 'gte': return a >= b;
        default: throw new Error(`unexpected operator ${op}`);
      }
    });
  });
}

/** The textbook definition: (createdAt, id) strictly after the cursor in the given order. */
function after(row: Row, c: Row, order: 'asc' | 'desc'): boolean {
  const t = row.createdAt.getTime() - c.createdAt.getTime();
  const cmp = t !== 0 ? Math.sign(t) : row.id < c.id ? -1 : row.id > c.id ? 1 : 0;
  return order === 'desc' ? cmp < 0 : cmp > 0;
}

describe('keysetWhere', () => {
  it('leads with an indexable range on the sort column, then breaks ties by id', () => {
    const at = new Date('2026-03-01T10:00:00.000Z');
    expect(keysetWhere<Prisma.RewardWhereInput>('createdAt', at, 'b', 'desc')).toEqual({
      AND: [{ createdAt: { lte: at } }, { OR: [{ createdAt: { lt: at } }, { id: { lt: 'b' } }] }],
    });
    expect(keysetWhere<Prisma.RewardWhereInput>('createdAt', at, 'b', 'asc')).toEqual({
      AND: [{ createdAt: { gte: at } }, { OR: [{ createdAt: { gt: at } }, { id: { gt: 'b' } }] }],
    });
  });

  it('selects exactly the rows after the cursor, including ties on the sort column', () => {
    const base = Date.parse('2026-03-01T10:00:00.000Z');
    const rows: Row[] = [];
    for (let i = 0; i < 60; i++) rows.push({ createdAt: new Date(base + Math.floor(i / 4) * 1000), id: `id-${String(i % 7).padStart(2, '0')}-${i}` });
    for (const order of ['asc', 'desc'] as const) {
      for (const c of rows) {
        const where = keysetWhere<Prisma.RewardWhereInput>('createdAt', c.createdAt, c.id, order) as Cond;
        for (const r of rows) expect(matches(r, where)).toBe(after(r, c, order));
      }
    }
  });
});

describe('keysetSql', () => {
  it('renders the same predicate shape with bound parameters', () => {
    const at = new Date('2026-03-01T10:00:00.000Z');
    const desc = keysetSql(Prisma.sql`a."created_at"`, Prisma.sql`a."id"`, at, '00000000-0000-4000-8000-000000000001', 'desc');
    expect(desc.sql.replace(/\s+/g, ' ')).toBe('(a."created_at" <= ?::timestamptz AND (a."created_at" < ?::timestamptz OR a."id" < ?::uuid))');
    expect(desc.values).toEqual([at, at, '00000000-0000-4000-8000-000000000001']);
    const asc = keysetSql(Prisma.sql`a."created_at"`, Prisma.sql`a."id"`, at, 'x', 'asc');
    expect(asc.sql).toContain('>= ?::timestamptz');
    expect(asc.sql).toContain('a."id" > ?::uuid');
  });
});
