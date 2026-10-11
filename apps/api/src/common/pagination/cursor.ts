import type { ApiPage } from '@app/shared';
import type { z } from 'zod';
import { validationFailed } from '../errors/app-error';

/**
 * Opaque cursors = base64url(JSON of the sort key). Always decode with a schema so a tampered cursor
 * becomes a 400 VALIDATION_FAILED instead of a broken query.
 *
 * Keyset pattern (sort by createdAt desc, id desc):
 *   const cursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });
 *   const c = decodeCursor(query.cursor, cursorSchema);
 *   const rows = await db.reward.findMany({
 *     // keysetWhere (./keyset.ts): index-friendly form of "(createdAt, id) < (c.createdAt, c.id)"
 *     where: c ? keysetWhere<Prisma.RewardWhereInput>('createdAt', new Date(c.createdAt), c.id, 'desc') : {},
 *     orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
 *     take: query.limit + 1,                     // fetch one extra row to detect a next page
 *   });
 *   return paginate(rows, query.limit, (r) => ({ createdAt: r.createdAt.toISOString(), id: r.id }), toDto);
 */

export const MAX_CURSOR_LENGTH = 512;

export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** Returns undefined for an absent cursor; throws 400 VALIDATION_FAILED for a malformed one. */
export function decodeCursor<S extends z.ZodType>(cursor: string | null | undefined, schema: S): z.output<S> | undefined {
  if (cursor === undefined || cursor === null || cursor === '') return undefined;
  const invalid = () => validationFailed('Invalid pagination cursor', { issues: [{ path: 'cursor', message: 'Invalid cursor', code: 'custom' }] });
  if (cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw invalid();
  return result.data;
}

/**
 * Builds the list envelope from rows fetched with `take: limit + 1`.
 * @param cursorOf sort key of a row (encoded as the next cursor from the last returned row)
 * @param map optional row → DTO mapper
 */
export function paginate<Row, Out = Row>(
  rows: readonly Row[],
  limit: number,
  cursorOf: (row: Row) => unknown,
  map?: (row: Row) => Out,
): ApiPage<Out> {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows.slice();
  const last = pageRows[pageRows.length - 1];
  return {
    data: map ? pageRows.map(map) : (pageRows as unknown as Out[]),
    page: { nextCursor: hasMore && last !== undefined ? encodeCursor(cursorOf(last)) : null, limit },
  };
}
