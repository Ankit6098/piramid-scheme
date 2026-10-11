import { PrismaPg } from '@prisma/adapter-pg';
import type { PoolConfig } from 'pg';
import { PrismaClient } from '../../generated/prisma/client';

/** Session limits for every pooled connection (all in milliseconds). */
export interface DbSessionLimits {
  /** Max wait for a pooled connection / a new connection (pg `connectionTimeoutMillis`). */
  connectTimeoutMs: number;
  /**
   * Session default `statement_timeout`. Keep it ≤ the shortest interactive-transaction timeout
   * (15 s): Prisma's transaction timeout does not cancel the statement that is running on the
   * server, this does. Long, deliberate work raises it with `SET LOCAL` (see `setLocalTimeouts`).
   */
  statementTimeoutMs: number;
  /** Session default `lock_timeout`: no row/advisory lock wait can hold a connection longer. */
  lockTimeoutMs: number;
}

export const DEFAULT_DB_SESSION_LIMITS: DbSessionLimits = {
  connectTimeoutMs: 5_000,
  statementTimeoutMs: 15_000,
  lockTimeoutMs: 5_000,
};

/**
 * pg pool options shared by the API, the worker, the seed and the tests:
 * - `TimeZone=UTC` for every session. @prisma/adapter-pg sends JS Dates as UTC wall-clock text
 *   without an offset, which PostgreSQL reads in the *session* time zone; a server or role with
 *   another TimeZone would shift every timestamptz parameter (PrismaService asserts UTC at boot).
 * - bounded connection, statement and lock waits, so a blocked request fails fast (HTTP 503,
 *   retryable) instead of pinning a pool connection.
 */
export function pgPoolConfig(connectionString: string, poolMax: number, limits: DbSessionLimits = DEFAULT_DB_SESSION_LIMITS): PoolConfig {
  return {
    connectionString,
    max: poolMax,
    connectionTimeoutMillis: limits.connectTimeoutMs,
    statement_timeout: limits.statementTimeoutMs,
    lock_timeout: limits.lockTimeoutMs,
    options: '-c TimeZone=UTC',
  };
}

/**
 * Builds a PrismaClient wired to the pg driver adapter (Prisma 7). Used by PrismaService, the seed
 * script and test utilities. Nest-free on purpose.
 */
export function createPrismaClient(connectionString: string, poolMax = 10, limits: DbSessionLimits = DEFAULT_DB_SESSION_LIMITS): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg(pgPoolConfig(connectionString, poolMax, limits)) });
}
