import { ErrorCode } from '@app/shared';
import { AppError } from './app-error';

/**
 * Normalized view of a database error, whichever layer raised it:
 * - `PrismaClientKnownRequestError` (`code` = Pxxxx; with the pg driver adapter the SQLSTATE lives in
 *   `meta.driverAdapterError.cause.originalCode`). Mapping done by Prisma 7 + @prisma/adapter-pg:
 *     23505 → P2002, 23503 & 23001 → P2003, other SQLSTATEs (23514, 23P01, P0001, …) → P2039
 *     (or P2010 for $queryRaw/$executeRaw) with `cause.kind = 'postgres'`.
 * - `DriverAdapterError` (`cause.originalCode`), e.g. errors raised while committing.
 * - a raw `pg` DatabaseError (`code` = SQLSTATE) when using the pool directly.
 */
export interface DbErrorInfo {
  sqlState: string | null;
  prismaCode: string | null;
  message: string | null;
  constraint: string | null;
}

const PRISMA_CODE = /^P[1-9]\d{3}$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;

export const SqlState = {
  RestrictViolation: '23001',
  NotNullViolation: '23502',
  ForeignKeyViolation: '23503',
  UniqueViolation: '23505',
  CheckViolation: '23514',
  ExclusionViolation: '23P01',
  SerializationFailure: '40001',
  DeadlockDetected: '40P01',
  InvalidTextRepresentation: '22P02',
  StringDataRightTruncation: '22001',
  NumericValueOutOfRange: '22003',
  /** lock_timeout expired (row or advisory lock wait). */
  LockNotAvailable: '55P03',
  /** statement_timeout expired (or the statement was cancelled). */
  QueryCanceled: '57014',
} as const;

/** SQLSTATEs raised by our integrity triggers / constraints → HTTP 409 INVARIANT_VIOLATION. */
const INVARIANT_STATES = new Set<string>([
  SqlState.RestrictViolation,
  SqlState.CheckViolation,
  SqlState.ExclusionViolation,
]);

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

export function inspectDbError(err: unknown): DbErrorInfo | null {
  const info: DbErrorInfo = { sqlState: null, prismaCode: null, message: null, constraint: null };
  const seen = new Set<unknown>();
  let isPrismaError = false;

  const visit = (value: unknown, depth: number): void => {
    const o = asRecord(value);
    if (!o || seen.has(o) || depth > 6) return;
    seen.add(o);
    const name = typeof o.name === 'string' ? o.name : (o.constructor as { name?: string } | undefined)?.name;
    if (name && /^PrismaClient|DriverAdapterError/.test(name)) isPrismaError = true;

    if (typeof o.code === 'string') {
      if (PRISMA_CODE.test(o.code)) info.prismaCode ??= o.code;
      else if (SQLSTATE.test(o.code)) info.sqlState ??= o.code;
    }
    if (typeof o.originalCode === 'string' && SQLSTATE.test(o.originalCode)) info.sqlState ??= o.originalCode;
    if (typeof o.originalMessage === 'string') info.message ??= o.originalMessage;
    if (typeof o.constraint === 'string') info.constraint ??= o.constraint;
    const c = asRecord(o.constraint);
    if (c && typeof c.index === 'string') info.constraint ??= c.index;
    if (c && Array.isArray(c.fields)) info.constraint ??= (c.fields as unknown[]).join(',');

    visit(o.cause, depth + 1);
    const meta = asRecord(o.meta);
    if (meta) {
      visit(meta.driverAdapterError, depth + 1);
      if (Array.isArray(meta.target)) info.constraint ??= (meta.target as unknown[]).join(',');
      else if (typeof meta.target === 'string') info.constraint ??= meta.target;
    }
    // pg DatabaseError: plain message (never `detail`, which can echo row values).
    if (!info.message && typeof o.message === 'string' && typeof o.severity === 'string') info.message = o.message;
  };

  visit(err, 0);

  // Last resort: Prisma "Raw query failed. Code: `23514`. Message: `...`" style messages.
  if (!info.sqlState && err instanceof Error) {
    const m = /Code: `([0-9A-Z]{5})`/.exec(err.message);
    if (m?.[1]) info.sqlState = m[1];
  }
  if (!info.constraint && info.message) {
    const m = /constraint "([^"]+)"/.exec(info.message);
    if (m?.[1]) info.constraint = m[1];
  }
  if (!info.sqlState && !info.prismaCode && !isPrismaError) return null;
  return info;
}

/** Maps a database error to an AppError, or null when it is not a recognised/expected DB failure. */
export function mapDbError(err: unknown): AppError | null {
  // pg-pool rejects with a plain Error (no code) when no connection frees up in time.
  if (isPoolTimeout(err)) return busy(err);
  const info = inspectDbError(err);
  if (!info) return null;
  const { sqlState, prismaCode, constraint } = info;

  if (sqlState && INVARIANT_STATES.has(sqlState)) {
    return new AppError(ErrorCode.InvariantViolation, 'The change violates a data integrity rule', 409, {
      sqlState,
      ...(constraint ? { constraint } : {}),
      // Messages of our triggers/CHECKs are written by us and never include row data.
      ...(info.message ? { reason: info.message } : {}),
    }, { cause: err });
  }
  if (sqlState === SqlState.UniqueViolation || prismaCode === 'P2002') {
    return new AppError(ErrorCode.Conflict, 'A record with the same unique value already exists', 409,
      constraint ? { constraint } : undefined, { cause: err });
  }
  if (sqlState === SqlState.ForeignKeyViolation || prismaCode === 'P2003') {
    return new AppError(ErrorCode.Conflict, 'A referenced record does not exist or is still in use', 409,
      constraint ? { constraint } : undefined, { cause: err });
  }
  if (prismaCode === 'P2025' || prismaCode === 'P2001' || prismaCode === 'P2018') {
    return new AppError(ErrorCode.NotFound, 'Record not found', 404, undefined, { cause: err });
  }
  if (sqlState === SqlState.SerializationFailure || sqlState === SqlState.DeadlockDetected || prismaCode === 'P2034') {
    return new AppError(ErrorCode.Conflict, 'The record was modified concurrently. Please retry', 409,
      { retryable: true }, { cause: err });
  }
  if (
    sqlState === SqlState.InvalidTextRepresentation ||
    sqlState === SqlState.StringDataRightTruncation ||
    sqlState === SqlState.NumericValueOutOfRange ||
    prismaCode === 'P2000' || prismaCode === 'P2007' || prismaCode === 'P2020' || prismaCode === 'P2023'
  ) {
    return new AppError(ErrorCode.ValidationFailed, 'A value in the request is invalid or too long', 400,
      undefined, { cause: err });
  }
  if (prismaCode && /^P10(0[0-2]|17)$/.test(prismaCode)) {
    return new AppError(ErrorCode.ServiceUnavailable, 'Database temporarily unavailable', 503, { retryable: true }, { cause: err });
  }
  // Bounded waits (lock_timeout, statement_timeout, pool/transaction timeouts — see create-client.ts):
  // the request gave up instead of queueing; nothing was written, so the client may retry.
  if (
    sqlState === SqlState.LockNotAvailable ||
    sqlState === SqlState.QueryCanceled ||
    prismaCode === 'P2024' ||
    prismaCode === 'P2028' ||
    prismaCode === 'P2037'
  ) {
    return busy(err);
  }
  return null;
}

function busy(err: unknown): AppError {
  return new AppError(ErrorCode.ServiceUnavailable, 'The service is busy. Please retry', 503, { retryable: true }, { cause: err });
}

/** node-postgres pool: "timeout exceeded when trying to connect" (connectionTimeoutMillis). */
function isPoolTimeout(err: unknown): boolean {
  const seen = new Set<unknown>();
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 6 && !seen.has(e); depth++) {
    seen.add(e);
    const o = e as { message?: unknown; cause?: unknown };
    if (typeof o.message === 'string' && /timeout exceeded when trying to connect|Connection terminated due to connection timeout/i.test(o.message)) {
      return true;
    }
    e = o.cause;
  }
  return false;
}
