import type { Prisma } from '../../generated/prisma/client';
import { withLockTimeout } from './local-settings';

type TxLike = Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw'>;

/** Advisory lock key guarding the referral tree (checked by the integrity triggers). */
export const REFERRAL_TREE_LOCK = { classId: 7301, objId: 1 } as const;

/**
 * Longest wait for the SHARED tree lock (registration, reward engine). A sponsor correction holds
 * the exclusive lock for seconds; waiters give up after this and fail with 55P03 → 503 (retryable)
 * instead of holding a pool connection for the whole correction.
 */
export const REFERRAL_TREE_SHARED_LOCK_TIMEOUT_MS = 3_000;

/**
 * Registration side of the referral write protocol (business rules §6): inside the transaction that
 * INSERTs the users row, take the SHARED tree lock, then insert the depth-0 self row → relationship →
 * ancestor rows. No savepoints in that transaction (the triggers recognise rows "created in this
 * transaction" by xmin). Waits at most `timeoutMs` (`SET LOCAL lock_timeout`, restored afterwards).
 */
export async function lockReferralTreeShared(tx: TxLike, timeoutMs = REFERRAL_TREE_SHARED_LOCK_TIMEOUT_MS): Promise<void> {
  await withLockTimeout(tx, timeoutMs, () => tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(7301, 1)`);
}

/**
 * Correction side: take the EXCLUSIVE tree lock FIRST, insert the `referral_corrections` row, then
 * `setReferralCorrectionId(tx, id)` before rewriting the relationship and closure rows.
 */
export async function lockReferralTreeExclusive(tx: TxLike): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(7301, 1)`;
}

/** `SET LOCAL app.referral_correction_id = '<id>'` (transaction-scoped). */
export async function setReferralCorrectionId(tx: TxLike, correctionId: string): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.referral_correction_id', ${correctionId}, true)`;
}
