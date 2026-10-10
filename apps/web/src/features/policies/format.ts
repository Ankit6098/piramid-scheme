/**
 * Formatting helpers for policies. Amounts always use the program's own snapshot (unit, currency,
 * minor units) — never the live platform settings. Percentages are integer basis points
 * (100 bps = 1%) and are parsed from text without floating point.
 */
import type { PolicyProgramContextDto, RewardUnit } from '@app/shared';

import type { AmountFormatOverride } from '@/providers/platform-settings-provider';

type ProgramUnit = Pick<
  PolicyProgramContextDto,
  'rewardUnit' | 'currencyCode' | 'currencyMinorUnits'
>;

/** Format override for reward-unit amounts (fixed levels, caps, max total, allocations). */
export function rewardFormat(program: ProgramUnit, pointsLabel?: string): AmountFormatOverride {
  return {
    unit: program.rewardUnit,
    currencyCode: program.currencyCode,
    minorUnits: program.currencyMinorUnits,
    pointsLabel,
  };
}

/** Format override for currency amounts (sale amounts, minimum sale). Use with `kind="currency"`. */
export function currencyFormat(program: ProgramUnit): AmountFormatOverride {
  return { currencyCode: program.currencyCode, minorUnits: program.currencyMinorUnits };
}

/** Same as `rewardFormat` for a dry-run result's own unit snapshot. */
export function unitFormat(
  unit: { rewardUnit: RewardUnit; currencyCode: string; currencyMinorUnits: number },
  pointsLabel?: string,
): AmountFormatOverride {
  return {
    unit: unit.rewardUnit,
    currencyCode: unit.currencyCode,
    minorUnits: unit.currencyMinorUnits,
    pointsLabel,
  };
}

/** 1250 → "12.5", 1000 → "10", 5 → "0.05" (value for a percentage text input; integer math only). */
export function bpsToPercentText(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = Math.abs(bps % 100);
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}

/**
 * Parses a user-entered percentage ("12.5", "12.50 %", ".5") into integer basis points (1250, 50).
 * Returns null when the text is not a non-negative percentage with at most two decimals.
 * Never uses floating point: the whole and fraction parts are read as separate integers.
 */
export function percentTextToBps(text: string): number | null {
  const cleaned = text.replace(/[\s%]/g, '').replace(',', '.');
  const match = /^(\d{0,3})(?:\.(\d{0,2}))?$/.exec(cleaned);
  if (!match || cleaned === '' || cleaned === '.') return null;
  const whole = Number(match[1] || '0');
  const frac = Number((match[2] ?? '').padEnd(2, '0'));
  return whole * 100 + frac;
}

/** Parses a whole number ("1,000" → 1000). Returns null when invalid or above `max`. */
export function parseWholeNumber(text: string, max = 1_000_000_000): number | null {
  const cleaned = text.replace(/[\s,_]/g, '');
  if (!/^\d{1,10}$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return value <= max ? value : null;
}

/** Width (0–100, two decimals) of `part` relative to `scale`, for presentational bars only. */
export function shareOf(part: bigint, scale: bigint): number {
  if (scale <= BigInt(0) || part <= BigInt(0)) return 0;
  const clamped = part > scale ? scale : part;
  return Number((clamped * BigInt(10_000)) / scale) / 100;
}

/** Parses an integer minor-amount string ("150000") to bigint; anything else → 0. */
export function toBigIntOrZero(value: string | null | undefined): bigint {
  return typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : BigInt(0);
}
