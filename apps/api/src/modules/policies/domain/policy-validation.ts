/**
 * Pure validation of a reward policy version before it may be published (business-rules §7).
 * Errors block publishing; warnings are shown to the admin but do not block.
 */
import type { ProgramStatus, QualifyingEventType } from '@app/shared';
import type { CalcRule } from '../../rewards/domain/reward-calculator';
import { MAX_BUDGET_BPS } from '../../rewards/domain/reward-calculator';

export const MAX_POLICY_DEPTH = 10;
/** Allowed clock skew when checking that a policy does not start in the past. */
export const PUBLISH_CLOCK_SKEW_MS = 60_000;

export interface PolicyDraft {
  maxDepth: number;
  budgetBps: number;
  maxTotalPerEventMinor: bigint | null;
  minEventAmountMinor: bigint;
  triggerEventTypes: readonly QualifyingEventType[];
  effectiveFrom: Date;
  effectiveTo: Date | null;
  rules: readonly CalcRule[];
}

export interface PolicyContext {
  programMaxDepth: number;
  programStatus: ProgramStatus;
  now: Date;
  /** True when validating for publication (adds time-based checks). */
  forPublish: boolean;
}

export interface PolicyIssue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export function validatePolicy(draft: PolicyDraft, ctx: PolicyContext): PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  const error = (path: string, message: string) => issues.push({ severity: 'error', path, message });
  const warn = (path: string, message: string) => issues.push({ severity: 'warning', path, message });

  if (ctx.programStatus === 'COMPLETED' || ctx.programStatus === 'ARCHIVED') {
    error('program', `Policies cannot be published for a ${ctx.programStatus.toLowerCase()} program`);
  }

  const depthCeiling = Math.min(ctx.programMaxDepth, MAX_POLICY_DEPTH);
  if (!Number.isInteger(draft.maxDepth) || draft.maxDepth < 1 || draft.maxDepth > depthCeiling) {
    error('maxDepth', `Maximum depth must be between 1 and ${depthCeiling}`);
  }
  if (!Number.isInteger(draft.budgetBps) || draft.budgetBps < 1 || draft.budgetBps > MAX_BUDGET_BPS) {
    error('budgetBps', `Total reward budget must be between 0.01% and ${MAX_BUDGET_BPS / 100}% of the sale amount`);
  }
  if (draft.maxTotalPerEventMinor !== null && draft.maxTotalPerEventMinor <= 0n) {
    error('maxTotalPerEventMinor', 'Maximum total per sale must be greater than zero');
  }
  if (draft.minEventAmountMinor < 0n) {
    error('minEventAmountMinor', 'Minimum sale amount cannot be negative');
  }
  if (draft.triggerEventTypes.length === 0) {
    error('triggerEventTypes', 'Select at least one qualifying sale event type');
  }
  if (draft.effectiveTo !== null && draft.effectiveTo.getTime() <= draft.effectiveFrom.getTime()) {
    error('effectiveTo', 'End must be after the start');
  }
  if (ctx.forPublish && draft.effectiveFrom.getTime() < ctx.now.getTime() - PUBLISH_CLOCK_SKEW_MS) {
    error('effectiveFrom', 'Policies cannot take effect in the past; choose now or a future date');
  }

  if (draft.rules.length === 0) {
    error('rules', 'Add at least one reward level');
  }

  const seen = new Set<number>();
  let percentageTotal = 0;
  let fixedTotal = 0n;
  draft.rules.forEach((rule, i) => {
    const path = `rules.${i}`;
    if (!Number.isInteger(rule.level) || rule.level < 1 || rule.level > draft.maxDepth) {
      error(`${path}.level`, `Level must be between 1 and the maximum depth (${draft.maxDepth})`);
    }
    if (seen.has(rule.level)) error(`${path}.level`, `Level ${rule.level} is defined more than once`);
    seen.add(rule.level);

    if (rule.calcType === 'FIXED') {
      if (rule.fixedAmountMinor === null || rule.fixedAmountMinor <= 0n) {
        error(`${path}.fixedAmountMinor`, 'Fixed amount must be greater than zero');
      } else {
        fixedTotal += rule.fixedAmountMinor;
      }
      if (rule.percentageBps !== null) error(`${path}.percentageBps`, 'Fixed rules cannot have a percentage');
    } else {
      if (rule.percentageBps === null || !Number.isInteger(rule.percentageBps) || rule.percentageBps < 1 || rule.percentageBps > MAX_BUDGET_BPS) {
        error(`${path}.percentageBps`, `Percentage must be between 0.01% and ${MAX_BUDGET_BPS / 100}%`);
      } else {
        percentageTotal += rule.percentageBps;
      }
      if (rule.fixedAmountMinor !== null) error(`${path}.fixedAmountMinor`, 'Percentage rules cannot have a fixed amount');
    }
    if (rule.capMinor !== null && rule.capMinor <= 0n) {
      error(`${path}.capMinor`, 'Cap must be greater than zero');
    }
  });

  if (percentageTotal > draft.budgetBps) {
    error('rules', `Percentage levels add up to ${percentageTotal / 100}% which exceeds the ${draft.budgetBps / 100}% budget`);
  }
  if (draft.maxTotalPerEventMinor !== null && fixedTotal > draft.maxTotalPerEventMinor) {
    warn('rules', 'Fixed amounts add up to more than the maximum total per sale; deeper levels will be reduced');
  }
  if (fixedTotal > 0n) {
    // Smallest sale for which all fixed levels fit in the budget.
    const breakEven = draft.budgetBps > 0 ? (fixedTotal * 10_000n + BigInt(draft.budgetBps) - 1n) / BigInt(draft.budgetBps) : null;
    if (breakEven !== null && draft.minEventAmountMinor < breakEven) {
      warn(
        'minEventAmountMinor',
        `Sales below ${breakEven.toString()} (minor units) cannot fund every fixed level; deeper levels will be reduced. Consider a minimum sale amount or percentage rules.`,
      );
    }
  }

  return issues;
}

export function hasErrors(issues: readonly PolicyIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
