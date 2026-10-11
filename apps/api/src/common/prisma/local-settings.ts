import type { Prisma } from '../../generated/prisma/client';

type TxLike = Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw'>;

function pgMs(ms: number): string {
  if (!Number.isInteger(ms) || ms < 1) throw new Error(`Invalid timeout ${ms} ms`);
  return `${ms}ms`;
}

/**
 * Transaction-scoped `SET LOCAL statement_timeout / lock_timeout` (reverts at COMMIT/ROLLBACK).
 * The pool's session defaults (create-client.ts) suit request-sized work; long, deliberate
 * transactions (a sponsor correction) raise them here, inside their own transaction only.
 */
export async function setLocalTimeouts(
  tx: TxLike,
  limits: { statementTimeoutMs?: number; lockTimeoutMs?: number },
): Promise<void> {
  if (limits.statementTimeoutMs !== undefined && limits.lockTimeoutMs !== undefined) {
    await tx.$executeRaw`SELECT set_config('statement_timeout', ${pgMs(limits.statementTimeoutMs)}, true),
                                set_config('lock_timeout', ${pgMs(limits.lockTimeoutMs)}, true)`;
  } else if (limits.statementTimeoutMs !== undefined) {
    await tx.$executeRaw`SELECT set_config('statement_timeout', ${pgMs(limits.statementTimeoutMs)}, true)`;
  } else if (limits.lockTimeoutMs !== undefined) {
    await tx.$executeRaw`SELECT set_config('lock_timeout', ${pgMs(limits.lockTimeoutMs)}, true)`;
  }
}

/**
 * Runs `fn` (one lock-taking statement) with `lock_timeout = timeoutMs`, then restores the
 * transaction's previous lock_timeout. A wait longer than that fails with SQLSTATE 55P03
 * (lock_not_available) → HTTP 503 SERVICE_UNAVAILABLE, `details.retryable = true`, and the
 * connection is released instead of queueing behind the lock holder.
 */
export async function withLockTimeout<T>(tx: TxLike, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  // MATERIALIZED: the previous value is read before set_config replaces it.
  const rows = await tx.$queryRaw<Array<{ prev: string }>>`
    WITH p AS MATERIALIZED (SELECT current_setting('lock_timeout') AS "v")
    SELECT p."v" AS "prev", set_config('lock_timeout', ${pgMs(timeoutMs)}, true) AS "now" FROM p`;
  const prev = rows[0]?.prev;
  const result = await fn();
  // Not in a `finally`: after a failed statement the transaction is aborted and must only roll back.
  if (prev !== undefined) await tx.$executeRaw`SELECT set_config('lock_timeout', ${prev}, true)`;
  return result;
}
