/**
 * Pure dry-run (business rules §8): runs the production calculator on admin-supplied inputs and maps
 * the result to the response DTO. No I/O — the service supplies the ancestor chain (synthetic or the
 * real tree + eligibility at the sale instant).
 */
import type {
  CalcLevelDecision,
  CalcTraceStepDto,
  DryRunAncestorDto,
  DryRunLevelDto,
  DryRunResultDto,
  QualifyingEventType,
  RewardCalcType,
} from '@app/shared';
import {
  calculateRewards,
  checkEventAgainstPolicy,
  computeBase,
  computeBudget,
  MAX_BUDGET_BPS,
  type CalcAncestor,
  type CalcPolicy,
  type CalcUnit,
} from '../../rewards/domain/reward-calculator';

export const SYNTHETIC_ID_PREFIX = 'synthetic:';

export interface DryRunAncestor extends CalcAncestor {
  /** null in synthetic mode. */
  displayName: string | null;
}

export interface DryRunInput {
  policyVersionId: string;
  mode: 'SYNTHETIC' | 'MEMBER';
  eventType: QualifyingEventType;
  saleAmountMinor: bigint;
  occurredAt: Date | null;
  policy: CalcPolicy;
  unit: CalcUnit & { currencyCode: string };
  ancestors: readonly DryRunAncestor[];
}

/** Synthetic chain: `eligible[i]` describes the ancestor at depth i + 1. */
export function syntheticAncestors(chain: ReadonlyArray<{ eligible: boolean }>): DryRunAncestor[] {
  return chain.map((a, i) => ({
    userId: `${SYNTHETIC_ID_PREFIX}${i + 1}`,
    depth: i + 1,
    eligible: a.eligible,
    displayName: null,
    ...(a.eligible ? {} : { ineligibleReason: 'marked ineligible in the preview' }),
  }));
}

const realId = (id: unknown): string | null =>
  typeof id === 'string' && !id.startsWith(SYNTHETIC_ID_PREFIX) ? id : null;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

export function runDryRun(input: DryRunInput): DryRunResultDto {
  const event = { type: input.eventType, amountMinor: input.saleAmountMinor };
  const notApplicableReason = checkEventAgainstPolicy(event, input.policy);
  const baseMinor = computeBase(input.saleAmountMinor, input.unit);
  const hardCapMinor = (baseMinor * BigInt(MAX_BUDGET_BPS)) / 10_000n;
  const nameById = new Map(input.ancestors.map((a) => [a.userId, a.displayName]));

  const ancestors: DryRunAncestorDto[] = input.ancestors.map((a) => ({
    depth: a.depth,
    eligible: a.eligible,
    reason: a.ineligibleReason ?? null,
    userId: realId(a.userId),
    displayName: a.displayName,
  }));
  const unit = {
    rewardUnit: input.unit.rewardUnit,
    currencyCode: input.unit.currencyCode,
    currencyMinorUnits: input.unit.currencyMinorUnits,
    pointsPerCurrencyUnit: input.unit.pointsPerCurrencyUnit,
  };
  const common = {
    policyVersionId: input.policyVersionId,
    mode: input.mode,
    eventType: input.eventType,
    saleAmountMinor: input.saleAmountMinor.toString(),
    occurredAt: input.occurredAt?.toISOString() ?? null,
    unit,
    baseMinor: baseMinor.toString(),
    budgetBps: input.policy.budgetBps,
    hardCapMinor: hardCapMinor.toString(),
    ancestors,
  };

  if (notApplicableReason) {
    const budgetMinor = computeBudget(baseMinor, input.policy);
    return {
      ...common,
      applicable: false,
      notApplicableReason,
      budgetMinor: budgetMinor.toString(),
      totalAllocatedMinor: '0',
      unallocatedMinor: budgetMinor.toString(),
      allocations: [],
      levels: [],
      warnings: [`The engine would reject this sale: ${notApplicableReason}`],
      engineVersion: calculateRewards({ event, policy: input.policy, unit: input.unit, ancestors: [] }).engineVersion,
      trace: [],
    };
  }

  const result = calculateRewards({ event, policy: input.policy, unit: input.unit, ancestors: input.ancestors });
  const rulesByLevel = new Map(input.policy.rules.map((r) => [r.level, r]));

  const levels: DryRunLevelDto[] = result.trace.flatMap((step) => {
    if (step.step !== 'level') return [];
    const d = step.detail;
    const rule = rulesByLevel.get(step.level);
    const userId = str(d.userId);
    return [
      {
        level: step.level,
        decision: step.decision as CalcLevelDecision,
        depth: num(d.depth),
        userId: realId(userId),
        displayName: userId ? (nameById.get(userId) ?? null) : null,
        calcType: (rule?.calcType ?? null) as RewardCalcType | null,
        percentageBps: rule?.percentageBps ?? null,
        fixedAmountMinor: rule?.fixedAmountMinor?.toString() ?? null,
        capMinor: rule?.capMinor?.toString() ?? null,
        ruleAmountMinor: str(d.ruleAmountMinor),
        amountMinor: str(d.amountMinor),
        capped: d.capped === true,
        budgetLimited: d.budgetLimited === true,
        reason: str(d.reason),
      },
    ];
  });

  // Synthetic ids never leave the server.
  const trace = result.trace.map((step): CalcTraceStepDto => {
    if (step.step !== 'level' || typeof step.detail.userId !== 'string') return step as CalcTraceStepDto;
    return { ...step, detail: { ...step.detail, userId: realId(step.detail.userId) } } as CalcTraceStepDto;
  });

  return {
    ...common,
    applicable: true,
    notApplicableReason: null,
    budgetMinor: result.budgetMinor.toString(),
    totalAllocatedMinor: result.totalAllocatedMinor.toString(),
    unallocatedMinor: (result.budgetMinor - result.totalAllocatedMinor).toString(),
    allocations: result.allocations.map((a) => ({
      level: a.level,
      depth: a.depth,
      userId: realId(a.recipientUserId),
      displayName: nameById.get(a.recipientUserId) ?? null,
      ruleAmountMinor: a.ruleAmountMinor.toString(),
      amountMinor: a.amountMinor.toString(),
      capped: a.capped,
      budgetLimited: a.budgetLimited,
    })),
    levels,
    warnings: result.warnings,
    engineVersion: result.engineVersion,
    trace,
  };
}
