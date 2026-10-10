/**
 * Labels, tones and format helpers for sales events (values not covered by `lib/enum-labels.ts`).
 */
import type {
  CalcLevelDecision,
  SaleEventProgramRefDto,
  SaleIntakeOutcome,
  SaleProgramOptionDto,
} from '@app/shared';

import type { StatusTone } from '@/lib/enum-labels';
import type { AmountFormatOverride } from '@/providers/platform-settings-provider';

interface LabelMeta {
  label: string;
  tone: StatusTone;
  description?: string;
}

export const OUTCOME_META: Record<SaleIntakeOutcome, LabelMeta> = {
  REWARDS_CREATED: { label: 'Rewards created', tone: 'success' },
  NO_ELIGIBLE_RECIPIENTS: {
    label: 'No eligible recipients',
    tone: 'muted',
    description: 'No eligible upline member qualified for a reward',
  },
  REJECTED: { label: 'Rejected', tone: 'destructive' },
  PENDING: {
    label: 'Processing',
    tone: 'info',
    description: 'Stored; rewards are being calculated',
  },
  REVERSED: { label: 'Reversed', tone: 'destructive-outline' },
};

export const DECISION_META: Record<CalcLevelDecision, LabelMeta> = {
  AWARDED: { label: 'Awarded', tone: 'success' },
  NO_RULE: { label: 'No rule', tone: 'muted', description: 'The policy has no rule for this level' },
  NO_ANCESTOR: {
    label: 'No ancestor',
    tone: 'muted',
    description: 'Nobody fills this level — the calculation stopped here',
  },
  INELIGIBLE_FORFEITED: {
    label: 'Ineligible — forfeited',
    tone: 'warning',
    description: 'The ancestor was not eligible at the sale date, so the level was forfeited',
  },
  BUDGET_EXHAUSTED: {
    label: 'Budget exhausted',
    tone: 'warning',
    description: 'The reward budget for this sale was already used up',
  },
  ZERO_AMOUNT: { label: 'Zero amount', tone: 'muted', description: 'The rule produced no amount' },
};

export function decisionMeta(decision: string): LabelMeta {
  return DECISION_META[decision as CalcLevelDecision] ?? { label: decision, tone: 'neutral' };
}

export function outcomeMeta(outcome: string): LabelMeta {
  return OUTCOME_META[outcome as SaleIntakeOutcome] ?? { label: outcome, tone: 'neutral' };
}

type ProgramSnapshot = Pick<
  SaleEventProgramRefDto | SaleProgramOptionDto,
  'rewardUnit' | 'currencyCode' | 'currencyMinorUnits'
>;

/** Reward-unit format from a program snapshot (reward totals, allocations). */
export function programRewardFormat(program: ProgramSnapshot): AmountFormatOverride {
  return {
    unit: program.rewardUnit,
    currencyCode: program.currencyCode,
    minorUnits: program.currencyMinorUnits,
  };
}

/** Currency format for sale amounts recorded in a program's currency. */
export function programCurrencyFormat(
  program: ProgramSnapshot,
  currencyCode = program.currencyCode,
): AmountFormatOverride {
  return { currencyCode, minorUnits: program.currencyMinorUnits };
}

/** "Summer Promo · SPR" (+ status when the program is not active). */
export function programOptionLabel(program: SaleProgramOptionDto, statusLabel?: string): string {
  const base = `${program.name} · ${program.code}`;
  return program.status === 'ACTIVE' || !statusLabel ? base : `${base} (${statusLabel})`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
