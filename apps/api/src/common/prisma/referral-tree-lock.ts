import type { Prisma } from '../../generated/prisma/client';

type TxLike = Pick<Prisma.TransactionClient, '$executeRaw'>;

/** Advisory lock key guarding the referral tree (checked by the integrity triggers). */
export const REFERRAL_TREE_LOCK = { classId: 7301, objId: 1 } as const;

/**
 * Registration side of the referral write protocol (business rules §6): inside the transaction that
 * INSERTs the users row, take the SHARED tree lock, then insert the depth-0 self row → relationship →
 * ancestor rows. No savepoints in that transaction (the triggers recognise rows "created in this
 * transaction" by xmin).
 */
export async function lockReferralTreeShared(tx: TxLike): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(7301, 1)`;
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
