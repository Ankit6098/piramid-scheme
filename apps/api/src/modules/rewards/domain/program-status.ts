import type { ProgramStatus } from '@app/shared';

export interface ProgramStatusChangeRow {
  fromStatus: ProgramStatus | null;
  toStatus: ProgramStatus;
  changedAt: Date;
}

/** How many of the newest status changes at or before an instant to read for `statusInForce`. */
export const STATUS_CHANGES_LOOKBACK = 10;

/**
 * Program status in force at an instant, given the status changes at or before it. Several changes
 * can share one timestamp (`changed_at = now()` is the transaction start, e.g. a program inserted and
 * published in one transaction), and SQL breaks such ties arbitrarily: within the latest instant the
 * status in force is the end of the chain — the `toStatus` that no other change at that instant moves
 * away from. Null when there is no change yet.
 */
export function statusInForce(changes: readonly ProgramStatusChangeRow[]): ProgramStatus | null {
  if (changes.length === 0) return null;
  const latest = Math.max(...changes.map((c) => c.changedAt.getTime()));
  const group = changes.filter((c) => c.changedAt.getTime() === latest);
  if (group.length === 1) return group[0]!.toStatus;
  const leftBehind = new Set(group.map((c) => c.fromStatus).filter((s): s is ProgramStatus => s !== null));
  const end = group.filter((c) => !leftBehind.has(c.toStatus));
  // A unique chain end; otherwise (a cycle within one instant) the newest row as returned by SQL.
  return (end.length === 1 ? end[0]! : group[0]!).toStatus;
}
