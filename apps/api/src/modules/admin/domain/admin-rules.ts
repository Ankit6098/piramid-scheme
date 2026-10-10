/**
 * Pure rules for admin member operations (business rules §2, §3) and overview/dashboard helpers.
 * The services translate refusals into AppErrors; the database re-checks the critical invariants
 * (no self-granted roles, ≥ 1 ACTIVE SUPER_ADMIN).
 */
import { isAdminRole, RoleKey, type RewardUnit, type UserStatus } from '@app/shared';

export type StatusAction = 'suspend' | 'reactivate';

export type StatusChangeRefusal =
  /** Admins cannot suspend/reactivate their own account. */
  | 'SELF'
  /** Only a SUPER_ADMIN may suspend/reactivate a user holding an administrative role. */
  | 'ADMIN_TARGET'
  /** suspend needs ACTIVE, reactivate needs SUSPENDED. */
  | 'INVALID_STATUS';

export interface StatusChangeActor {
  userId: string;
  roles: readonly string[];
}

export interface StatusChangeTarget {
  id: string;
  roles: readonly string[];
  status: UserStatus;
}

/** Whether `actor` may move `target` to SUSPENDED (suspend) or back to ACTIVE (reactivate). */
export function checkStatusChange(
  actor: StatusChangeActor,
  target: StatusChangeTarget,
  action: StatusAction,
): { allowed: true } | { allowed: false; reason: StatusChangeRefusal } {
  if (actor.userId === target.id) return { allowed: false, reason: 'SELF' };
  if (target.roles.some(isAdminRole) && !actor.roles.includes('SUPER_ADMIN')) {
    return { allowed: false, reason: 'ADMIN_TARGET' };
  }
  const required: UserStatus = action === 'suspend' ? 'ACTIVE' : 'SUSPENDED';
  if (target.status !== required) return { allowed: false, reason: 'INVALID_STATUS' };
  return { allowed: true };
}

const ROLE_ORDER = new Map<string, number>(RoleKey.map((r, i) => [r, i]));

/** Deduplicated, canonical-ordered role set that always contains MEMBER. */
export function normalizeRoles(roles: readonly RoleKey[]): RoleKey[] {
  const set = new Set<RoleKey>(['MEMBER', ...roles]);
  return [...set].sort((a, b) => (ROLE_ORDER.get(a) ?? 99) - (ROLE_ORDER.get(b) ?? 99));
}

/** Roles to insert and to delete to turn `current` into `requested` (both normalized). */
export function diffRoles(current: readonly RoleKey[], requested: readonly RoleKey[]): { granted: RoleKey[]; revoked: RoleKey[] } {
  const cur = new Set(current);
  const req = new Set(requested);
  return {
    granted: normalizeRoles(requested).filter((r) => !cur.has(r)),
    revoked: [...current].filter((r) => !req.has(r)).sort((a, b) => (ROLE_ORDER.get(a) ?? 99) - (ROLE_ORDER.get(b) ?? 99)),
  };
}

/** First name for greetings ("Anita Sharma" → "Anita"). */
export function firstNameOf(fullName: string): string {
  const first = fullName.trim().split(/\s+/)[0];
  return first && first.length > 0 ? first : fullName.trim();
}

// ─── Daily series ───────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` of the UTC calendar day of `date`. */
export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Start (00:00 UTC) of the first day of a `days`-long window ending with the UTC day of `now`. */
export function seriesStart(now: Date, days: number): Date {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(today - (days - 1) * DAY_MS);
}

export type DayCounts = ReadonlyMap<string, number>;

/**
 * One point per UTC day (oldest first) for `days` days ending today; days without rows are 0.
 * Keys of the maps are `YYYY-MM-DD` (see `utcDayKey`); keys outside the window are ignored.
 */
export function buildDailySeries(
  now: Date,
  days: number,
  counts: { registrations: DayCounts; sales: DayCounts; rewardsPosted: DayCounts },
): Array<{ date: string; registrations: number; sales: number; rewardsPosted: number }> {
  const start = seriesStart(now, days).getTime();
  return Array.from({ length: days }, (_, i) => {
    const date = utcDayKey(new Date(start + i * DAY_MS));
    return {
      date,
      registrations: counts.registrations.get(date) ?? 0,
      sales: counts.sales.get(date) ?? 0,
      rewardsPosted: counts.rewardsPosted.get(date) ?? 0,
    };
  });
}

// ─── Reward summary buckets ─────────────────────────────────────────────────

export interface LedgerBalanceRow {
  rewardUnit: RewardUnit;
  currencyCode: string;
  /** Σ CREDIT − Σ DEBIT on payable accounts. */
  balanceMinor: bigint;
}

export interface RewardStatusSumRow {
  rewardUnit: RewardUnit;
  currencyCode: string;
  status: string;
  amountMinor: bigint;
}

export interface RewardSummaryBucket {
  rewardUnit: RewardUnit;
  currencyCode: string;
  earnedMinor: bigint;
  pendingMinor: bigint;
  reversedMinor: bigint;
}

/**
 * Business rules §10: earned = ledger balance of the payable accounts; pending = PENDING_APPROVAL +
 * APPROVED; reversed = REVERSED. Rejected rewards are never totalled. One bucket per (unit, currency),
 * sorted by unit then currency; buckets that are all zero are dropped.
 */
export function mergeRewardSummary(ledger: readonly LedgerBalanceRow[], rewards: readonly RewardStatusSumRow[]): RewardSummaryBucket[] {
  const buckets = new Map<string, RewardSummaryBucket>();
  const bucket = (rewardUnit: RewardUnit, currencyCode: string) => {
    const key = `${rewardUnit}:${currencyCode}`;
    let b = buckets.get(key);
    if (!b) {
      b = { rewardUnit, currencyCode, earnedMinor: 0n, pendingMinor: 0n, reversedMinor: 0n };
      buckets.set(key, b);
    }
    return b;
  };
  for (const row of ledger) bucket(row.rewardUnit, row.currencyCode).earnedMinor += row.balanceMinor;
  for (const row of rewards) {
    if (row.status === 'PENDING_APPROVAL' || row.status === 'APPROVED') {
      bucket(row.rewardUnit, row.currencyCode).pendingMinor += row.amountMinor;
    } else if (row.status === 'REVERSED') {
      bucket(row.rewardUnit, row.currencyCode).reversedMinor += row.amountMinor;
    }
  }
  return [...buckets.values()]
    .filter((b) => b.earnedMinor !== 0n || b.pendingMinor !== 0n || b.reversedMinor !== 0n)
    .sort((x, y) => x.rewardUnit.localeCompare(y.rewardUnit) || x.currencyCode.localeCompare(y.currencyCode));
}

/** Escapes LIKE/ILIKE wildcards so user input matches literally (default escape char `\`). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}
