import type { ApiPage, ApiResponse } from '@app/shared';

/**
 * Response envelopes. Controllers return these explicitly:
 *   `return ok(dto)`                       → { data: dto }
 *   `return paginate(rows, limit, cursor)` → { data: [...], page: { nextCursor, limit } }   (see pagination/)
 * The global JsonSafeInterceptor converts bigint → string on the way out.
 */
export function ok<T>(data: T): ApiResponse<T> {
  return { data };
}

export type { ApiPage, ApiResponse };
