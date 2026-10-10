import { notFound, type Db } from '../../common';
import type { ProgramStatus } from '../../generated/prisma/client';

/**
 * Row-locks a program (`SELECT … FOR UPDATE`) so lifecycle changes, option edits and publish checks
 * serialize. Throws 404 when it does not exist. Use inside a transaction.
 */
export async function lockProgram(tx: Db, programId: string): Promise<{ id: string; status: ProgramStatus; version: number }> {
  const rows = await tx.$queryRaw<Array<{ id: string; status: ProgramStatus; version: number }>>`
    SELECT "id", "status", "version" FROM "programs" WHERE "id" = ${programId}::uuid FOR UPDATE`;
  const row = rows[0];
  if (!row) throw notFound('Program');
  return row;
}

/**
 * Sets the transaction-local reason that `trg_programs_log_status` copies into
 * `program_status_changes.reason` (an empty string clears it). Call right before the status UPDATE,
 * in the same transaction.
 */
export async function setStatusReason(tx: Db, reason: string | null | undefined): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.status_reason', ${reason ?? ''}, true)`;
}
