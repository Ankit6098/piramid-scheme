/**
 * Member-facing reward rules (business rules §10): calendar dates instead of timestamps, and the
 * earnings buckets (earned to date from the ledger, pending and reversed from reward rows). Pure.
 */
import type { EarningsBucketDto, RewardStatus, RewardUnit } from '@app/shared';

/** `YYYY-MM-DD` of `date` in `timeZone` (falls back to UTC for an unknown zone). */
export function calendarDate(date: Date | null | undefined, timeZone: string): string | null {
  if (!date) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export interface PayableBalanceInput {
  rewardUnit: RewardUnit;
  currencyCode: string;
  creditsMinor: bigint;
  debitsMinor: bigint;
}

export interface RewardSumInput {
  rewardUnit: RewardUnit;
  currencyCode: string;
  status: RewardStatus;
  amountMinor: bigint;
  count: number;
}

/**
 * Earnings per (unit, currency):
 * - earnedToDate = Σ credits − Σ debits on the member's payable accounts (posted − reversed);
 * - pending = PENDING_APPROVAL + APPROVED rewards; reversed = REVERSED rewards;
 * - REJECTED rewards are never totalled.
 * Buckets are sorted by unit then currency; a bucket exists when any figure or count is non-zero.
 */
export function buildEarningsBuckets(
  balances: readonly PayableBalanceInput[],
  rewardSums: readonly RewardSumInput[],
  minorUnitsByCurrency: ReadonlyMap<string, number>,
): EarningsBucketDto[] {
  interface Acc {
    rewardUnit: RewardUnit;
    currencyCode: string;
    earned: bigint;
    pending: bigint;
    reversed: bigint;
    postedCount: number;
    pendingCount: number;
    reversedCount: number;
  }
  const buckets = new Map<string, Acc>();
  const bucket = (rewardUnit: RewardUnit, currencyCode: string): Acc => {
    const key = `${rewardUnit}:${currencyCode}`;
    let b = buckets.get(key);
    if (!b) {
      b = { rewardUnit, currencyCode, earned: 0n, pending: 0n, reversed: 0n, postedCount: 0, pendingCount: 0, reversedCount: 0 };
      buckets.set(key, b);
    }
    return b;
  };
  for (const bal of balances) {
    bucket(bal.rewardUnit, bal.currencyCode).earned += bal.creditsMinor - bal.debitsMinor;
  }
  for (const s of rewardSums) {
    if (s.status === 'REJECTED') continue;
    const b = bucket(s.rewardUnit, s.currencyCode);
    if (s.status === 'PENDING_APPROVAL' || s.status === 'APPROVED') {
      b.pending += s.amountMinor;
      b.pendingCount += s.count;
    } else if (s.status === 'REVERSED') {
      b.reversed += s.amountMinor;
      b.reversedCount += s.count;
    } else if (s.status === 'POSTED') {
      b.postedCount += s.count;
    }
  }
  return [...buckets.values()]
    .filter((b) => b.earned !== 0n || b.pending !== 0n || b.reversed !== 0n || b.postedCount + b.pendingCount + b.reversedCount > 0)
    .sort((x, y) => (x.rewardUnit === y.rewardUnit ? x.currencyCode.localeCompare(y.currencyCode) : x.rewardUnit.localeCompare(y.rewardUnit)))
    .map((b) => ({
      rewardUnit: b.rewardUnit,
      currencyCode: b.currencyCode,
      currencyMinorUnits: minorUnitsByCurrency.get(b.currencyCode) ?? 0,
      earnedToDateMinor: b.earned.toString(),
      pendingMinor: b.pending.toString(),
      reversedMinor: b.reversed.toString(),
      postedCount: b.postedCount,
      pendingCount: b.pendingCount,
      reversedCount: b.reversedCount,
    }));
}
