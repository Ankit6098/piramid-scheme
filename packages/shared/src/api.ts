import { z } from 'zod';

/** Single-resource response envelope. */
export interface ApiResponse<T> {
  data: T;
}

export interface PageInfo {
  nextCursor: string | null;
  limit: number;
}

/** Cursor-paginated list envelope. */
export interface ApiPage<T> {
  data: T[];
  page: PageInfo;
}

export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 100;

export const cursorPageQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});
export type CursorPageQuery = z.infer<typeof cursorPageQuerySchema>;

/** Non-negative integer amount in minor units, transported as a decimal string (bigint-safe). */
export const minorAmountSchema = z.string().regex(/^\d{1,18}$/, 'Must be a whole number of minor units');

/** Strictly positive minor amount. */
export const positiveMinorAmountSchema = minorAmountSchema.refine(
  (v) => BigInt(v) > 0n,
  'Must be greater than zero',
);

export const uuidSchema = z.uuid();
export const isoDateTimeSchema = z.iso.datetime({ offset: true });
export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO 4217 code');
/** Basis points: 100 bps = 1%. */
export const bpsSchema = z.number().int().min(0).max(10_000);
export const reasonSchema = z
  .string()
  .trim()
  .min(10, 'Please give a reason (at least 10 characters)')
  .max(1000);
