import { Prisma } from '../../generated/prisma/client';

export type KeysetOrder = 'asc' | 'desc';
type KeysetValue = Date | string | number;

/**
 * Keyset ("seek") condition: rows strictly after the cursor row (`value`, `id`) for
 * `ORDER BY <field> <order>, id <order>`.
 *
 * Built as `field <= v AND (field < v OR id < cid)` (desc; `>=` / `>` for asc) rather than the
 * textbook `field < v OR (field = v AND id < cid)`: PostgreSQL cannot use a top-level OR as an index
 * condition, so the textbook form scans the index from its head on every page (deep pages and CSV
 * exports degrade to O(offset)). The leading range becomes the Index Cond; the OR only filters the
 * entries tied on `field`. Same rows, same order.
 *
 * @example
 *   const and: Prisma.RewardWhereInput[] = [filters];
 *   if (c) and.push(keysetWhere<Prisma.RewardWhereInput>('createdAt', new Date(c.createdAt), c.id, 'desc'));
 *   await db.reward.findMany({ where: { AND: and }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 });
 */
export function keysetWhere<W extends object>(
  field: Exclude<keyof W, 'AND' | 'OR' | 'NOT'> & string,
  value: KeysetValue,
  id: string,
  order: KeysetOrder = 'desc',
): W {
  const range = order === 'asc' ? 'gte' : 'lte';
  const strict = order === 'asc' ? 'gt' : 'lt';
  return {
    AND: [{ [field]: { [range]: value } }, { OR: [{ [field]: { [strict]: value } }, { id: { [strict]: id } }] }],
  } as W;
}

/**
 * Raw-SQL twin of `keysetWhere` for `$queryRaw` lists. `column` / `idColumn` are trusted SQL
 * fragments (e.g. Prisma.sql`a."created_at"`); `value` is bound as a timestamptz parameter (the
 * session TimeZone is pinned to UTC, see create-client.ts).
 */
export function keysetSql(column: Prisma.Sql, idColumn: Prisma.Sql, value: Date, id: string, order: KeysetOrder = 'desc'): Prisma.Sql {
  return order === 'asc'
    ? Prisma.sql`(${column} >= ${value}::timestamptz AND (${column} > ${value}::timestamptz OR ${idColumn} > ${id}::uuid))`
    : Prisma.sql`(${column} <= ${value}::timestamptz AND (${column} < ${value}::timestamptz OR ${idColumn} < ${id}::uuid))`;
}
