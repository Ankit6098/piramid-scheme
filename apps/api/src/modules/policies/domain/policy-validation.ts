/**
 * Pure validation of a reward policy version before it may be published (business-rules §7).
 * Errors block publishing; warnings are shown to the admin but do not block.
 */
import { formatCurrency, type ProgramStatus, type QualifyingEventType, type RewardUnit } from '@app/shared';
import type { CalcRule } from '../../rewards/domain/reward-calculator';
import { MAX_BUDGET_BPS } from '../../rewards/domain/reward-calculator';

export const MAX_POLICY_DEPTH = 10;
/** Allowed clock skew when checking that a policy does not start in the past. */
export const PUBLISH_CLOCK_SKEW_MS = 60_000;

const BPS_DENOMINATOR = 10_000n;

export interface PolicyDraft {
  maxDepth: number;
  budgetBps: number;
  maxTotalPerEventMinor: bigint | null;
  minEventAmountMinor: bigint;
  triggerEventTypes: readonly QualifyingEventType[];
  effectiveFrom: Date;
  effectiveTo: Date | null;
  rules: readonly CalcRule[];
  /** POINTS programs: points per major currency unit (default 1). */
  pointsPerCurrencyUnit?: number;
  /** Default true. */
  requiresApproval?: boolean;
}

/** The program's reward unit snapshot (amounts in the policy are interpreted with it). */
export interface PolicyUnitContext {
  rewardUnit: RewardUnit;
  currencyCode: string;
  currencyMinorUnits: number;
}

export interface PolicyContext {
  programMaxDepth: number;
  programStatus: ProgramStatus;
  now: Date;
  /** True when validating for publication (adds time-based checks). */
  forPublish: boolean;
  /** Enables unit-aware messages (break-even sale in the sale currency). */
  unit?: PolicyUnitContext;
  /** Whether the acting admin holds `policies:auto-approve` (undefined = not checked). */
  canAutoApprove?: boolean;
}

export interface PolicyIssue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
  code?: string;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** What a rule pays at most, independent of the sale (FIXED amounts after their cap; null for PERCENTAGE). */
function fixedRuleAmount(rule: CalcRule): bigint | null {
  if (rule.calcType !== 'FIXED' || rule.fixedAmountMinor === null || rule.fixedAmountMinor <= 0n) return null;
  return rule.capMinor !== null && rule.capMinor < rule.fixedAmountMinor ? rule.capMinor : rule.fixedAmountMinor;
}

/**
 * Smallest sale (currency minor units) whose budget can fund `fixedTotal` reward-unit minor units,
 * mirroring the calculator: base = sale (MONEY) or floor(sale × rate / 10^minor) (POINTS);
 * budget = floor(base × bps / 10 000). Null when there is nothing to fund.
 */
export function breakEvenSaleMinor(
  fixedTotal: bigint,
  budgetBps: number,
  unit: { rewardUnit: RewardUnit; currencyMinorUnits: number; pointsPerCurrencyUnit: number },
): bigint | null {
  if (fixedTotal <= 0n || !Number.isInteger(budgetBps) || budgetBps < 1) return null;
  const baseNeeded = ceilDiv(fixedTotal * BPS_DENOMINATOR, BigInt(budgetBps));
  if (unit.rewardUnit === 'MONEY') return baseNeeded;
  const rate = BigInt(Math.max(1, Math.trunc(unit.pointsPerCurrencyUnit)));
  return ceilDiv(baseNeeded * 10n ** BigInt(unit.currencyMinorUnits), rate);
}

export function validatePolicy(draft: PolicyDraft, ctx: PolicyContext): PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  const error = (path: string, message: string, code?: string) =>
    issues.push({ severity: 'error', path, message, ...(code ? { code } : {}) });
  const warn = (path: string, message: string, code?: string) =>
    issues.push({ severity: 'warning', path, message, ...(code ? { code } : {}) });

  if (ctx.programStatus === 'COMPLETED' || ctx.programStatus === 'ARCHIVED') {
    error('program', `Policies cannot be published for a ${ctx.programStatus.toLowerCase()} program`, 'PROGRAM_CLOSED');
  }

  const depthCeiling = Math.min(ctx.programMaxDepth, MAX_POLICY_DEPTH);
  if (!Number.isInteger(draft.maxDepth) || draft.maxDepth < 1 || draft.maxDepth > depthCeiling) {
    error('maxDepth', `Maximum depth must be between 1 and ${depthCeiling}`, 'DEPTH_OUT_OF_RANGE');
  }
  if (!Number.isInteger(draft.budgetBps) || draft.budgetBps < 1 || draft.budgetBps > MAX_BUDGET_BPS) {
    error(
      'budgetBps',
      `Total reward budget must be between 0.01% and ${MAX_BUDGET_BPS / 100}% of the sale amount`,
      'BUDGET_OUT_OF_RANGE',
    );
  }
  if (draft.maxTotalPerEventMinor !== null && draft.maxTotalPerEventMinor <= 0n) {
    error('maxTotalPerEventMinor', 'Maximum total per sale must be greater than zero', 'MAX_TOTAL_INVALID');
  }
  if (draft.minEventAmountMinor < 0n) {
    error('minEventAmountMinor', 'Minimum sale amount cannot be negative', 'MIN_AMOUNT_INVALID');
  }
  if (draft.triggerEventTypes.length === 0) {
    error('triggerEventTypes', 'Select at least one qualifying sale event type', 'NO_TRIGGER_TYPES');
  }
  if (draft.effectiveTo !== null && draft.effectiveTo.getTime() <= draft.effectiveFrom.getTime()) {
    error('effectiveTo', 'End must be after the start', 'RANGE_INVALID');
  }
  if (ctx.forPublish && draft.effectiveFrom.getTime() < ctx.now.getTime() - PUBLISH_CLOCK_SKEW_MS) {
    error('effectiveFrom', 'Policies cannot take effect in the past; choose now or a future date', 'RETROACTIVE');
  }
  const pointsRate = draft.pointsPerCurrencyUnit ?? 1;
  if (!Number.isInteger(pointsRate) || pointsRate < 1 || pointsRate > 1_000_000) {
    error('pointsPerCurrencyUnit', 'Points per currency unit must be a whole number between 1 and 1,000,000', 'POINTS_RATE_INVALID');
  }

  if (draft.requiresApproval === false) {
    if (ctx.canAutoApprove === false) {
      const message = 'Only a Super Admin can publish a policy whose rewards skip manual approval';
      if (ctx.forPublish) error('requiresApproval', message, 'AUTO_APPROVE_FORBIDDEN');
      else warn('requiresApproval', message, 'AUTO_APPROVE_FORBIDDEN');
    }
    warn(
      'requiresApproval',
      'Rewards from integration (API) sales will be approved and posted automatically. Manually recorded sales always need approval.',
      'AUTO_APPROVE',
    );
  }

  if (draft.rules.length === 0) {
    error('rules', 'Add at least one reward level', 'NO_RULES');
  }

  const seen = new Set<number>();
  let percentageTotal = 0;
  let fixedTotal = 0n;
  draft.rules.forEach((rule, i) => {
    const path = `rules.${i}`;
    if (!Number.isInteger(rule.level) || rule.level < 1 || rule.level > draft.maxDepth) {
      error(`${path}.level`, `Level must be between 1 and the maximum depth (${draft.maxDepth})`, 'LEVEL_OUT_OF_RANGE');
    }
    if (seen.has(rule.level)) error(`${path}.level`, `Level ${rule.level} is defined more than once`, 'LEVEL_DUPLICATE');
    seen.add(rule.level);

    if (rule.calcType === 'FIXED') {
      if (rule.fixedAmountMinor === null || rule.fixedAmountMinor <= 0n) {
        error(`${path}.fixedAmountMinor`, 'Fixed amount must be greater than zero', 'FIXED_AMOUNT_INVALID');
      } else {
        fixedTotal += fixedRuleAmount(rule) ?? 0n;
        if (rule.capMinor !== null && rule.capMinor >= rule.fixedAmountMinor) {
          warn(`${path}.capMinor`, 'The cap is not lower than the fixed amount, so it has no effect', 'CAP_NO_EFFECT');
        }
      }
      if (rule.percentageBps !== null) error(`${path}.percentageBps`, 'Fixed rules cannot have a percentage', 'RULE_SHAPE');
    } else {
      if (
        rule.percentageBps === null ||
        !Number.isInteger(rule.percentageBps) ||
        rule.percentageBps < 1 ||
        rule.percentageBps > MAX_BUDGET_BPS
      ) {
        error(`${path}.percentageBps`, `Percentage must be between 0.01% and ${MAX_BUDGET_BPS / 100}%`, 'PERCENTAGE_INVALID');
      } else {
        percentageTotal += rule.percentageBps;
      }
      if (rule.fixedAmountMinor !== null) error(`${path}.fixedAmountMinor`, 'Percentage rules cannot have a fixed amount', 'RULE_SHAPE');
    }
    if (rule.capMinor !== null && rule.capMinor <= 0n) {
      error(`${path}.capMinor`, 'Cap must be greater than zero', 'CAP_INVALID');
    }
  });

  if (percentageTotal > draft.budgetBps) {
    error(
      'rules',
      `Percentage levels add up to ${percentageTotal / 100}% which exceeds the ${draft.budgetBps / 100}% budget`,
      'PERCENTAGE_OVER_BUDGET',
    );
  }
  if (draft.maxTotalPerEventMinor !== null && fixedTotal > draft.maxTotalPerEventMinor) {
    warn(
      'rules',
      'Fixed amounts add up to more than the maximum total per sale; deeper levels will be reduced',
      'FIXED_OVER_MAX_TOTAL',
    );
  }
  if (fixedTotal > 0n) {
    // Smallest sale (in the sale currency) for which all fixed levels fit in the budget.
    const breakEven = breakEvenSaleMinor(fixedTotal, draft.budgetBps, {
      rewardUnit: ctx.unit?.rewardUnit ?? 'MONEY',
      currencyMinorUnits: ctx.unit?.currencyMinorUnits ?? 0,
      pointsPerCurrencyUnit: pointsRate,
    });
    if (breakEven !== null && draft.minEventAmountMinor < breakEven) {
      const amount = ctx.unit
        ? formatCurrency(breakEven, ctx.unit.currencyCode, ctx.unit.currencyMinorUnits)
        : `${breakEven.toString()} (minor units)`;
      warn(
        'minEventAmountMinor',
        `Sales below ${amount} cannot fund every fixed level; deeper levels will be reduced. Consider a minimum sale amount or percentage rules.`,
        'FIXED_BREAK_EVEN',
      );
    }
  }

  return issues;
}

export function hasErrors(issues: readonly PolicyIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
