/**
 * Pure reward calculation — no I/O, no clock, no randomness. Implements docs/business-rules.md §8.
 *
 * All amounts are bigint minor units of the *reward unit* (currency minor units in MONEY mode,
 * whole points in POINTS mode). The sale amount is always in currency minor units.
 */
import type {
  IneligibleAncestorBehavior,
  QualifyingEventType,
  RewardCalcType,
  RewardUnit,
  RoundingMode,
} from '@app/shared';

export const ENGINE_VERSION = '1.0.0';

/** Hard ceiling on the reward budget (50% of the sale), mirrored by a DB CHECK constraint. */
export const MAX_BUDGET_BPS = 5000;

/** How far up the tree COMPRESS mode searches for eligible ancestors. */
export const MAX_COMPRESSION_SEARCH_DEPTH = 50;

const BPS_DENOMINATOR = 10_000n;

/** Largest amount the database can store (`bigint` columns: 2^63 − 1). */
export const MAX_STORABLE_MINOR = 2n ** 63n - 1n;

/** Why a sale's reward base cannot be stored (POINTS conversion overflowing `bigint`), or null. */
export function checkBaseStorable(amountMinor: bigint, unit: CalcUnit): string | null {
  if (computeBase(amountMinor, unit) <= MAX_STORABLE_MINOR) return null;
  return 'The sale amount is too large: converted to points it exceeds the largest amount that can be stored';
}

export interface CalcRule {
  level: number;
  calcType: RewardCalcType;
  fixedAmountMinor: bigint | null;
  percentageBps: number | null;
  capMinor: bigint | null;
}

export interface CalcPolicy {
  id: string;
  version: number;
  maxDepth: number;
  budgetBps: number;
  maxTotalPerEventMinor: bigint | null;
  minEventAmountMinor: bigint;
  ineligibleAncestorBehavior: IneligibleAncestorBehavior;
  roundingMode: RoundingMode;
  triggerEventTypes: readonly QualifyingEventType[];
  rules: readonly CalcRule[];
}

export interface CalcEvent {
  type: QualifyingEventType;
  /** Sale amount in currency minor units. */
  amountMinor: bigint;
}

export interface CalcUnit {
  rewardUnit: RewardUnit;
  /** Minor units of the sale currency (e.g. 2 for INR). */
  currencyMinorUnits: number;
  /** Points per one major currency unit (POINTS mode only). */
  pointsPerCurrencyUnit: number;
}

export interface CalcAncestor {
  userId: string;
  /** Distance from the event subject: 1 = direct sponsor. */
  depth: number;
  eligible: boolean;
  /** Why the ancestor is not eligible (recorded in the trace). */
  ineligibleReason?: string;
}

export interface CalcInput {
  event: CalcEvent;
  policy: CalcPolicy;
  unit: CalcUnit;
  /** Ancestors of the subject ordered by depth ascending (depth ≥ 1). */
  ancestors: readonly CalcAncestor[];
}

export interface Allocation {
  level: number;
  recipientUserId: string;
  depth: number;
  /** Amount from the rule after rounding and the per-level cap, before the budget. */
  ruleAmountMinor: bigint;
  /** Final amount after budget allocation (> 0). */
  amountMinor: bigint;
  capped: boolean;
  budgetLimited: boolean;
}

export type TraceStep =
  | { step: 'base'; saleAmountMinor: string; rewardUnit: RewardUnit; baseMinor: string; note: string }
  | { step: 'budget'; budgetBps: number; budgetMinor: string; maxTotalPerEventMinor: string | null }
  | { step: 'level'; level: number; decision: LevelDecision; detail: Record<string, unknown> };

export type LevelDecision =
  | 'AWARDED'
  | 'NO_RULE'
  | 'NO_ANCESTOR'
  | 'INELIGIBLE_FORFEITED'
  | 'BUDGET_EXHAUSTED'
  | 'ZERO_AMOUNT';

export interface CalcResult {
  engineVersion: string;
  baseMinor: bigint;
  budgetMinor: bigint;
  totalAllocatedMinor: bigint;
  allocations: Allocation[];
  trace: TraceStep[];
  warnings: string[];
}

/** Reasons an event cannot be processed under a policy (null = acceptable). */
export function checkEventAgainstPolicy(event: CalcEvent, policy: CalcPolicy): string | null {
  if (event.amountMinor <= 0n) return 'Sale amount must be greater than zero';
  if (!policy.triggerEventTypes.includes(event.type)) {
    return `Policy v${policy.version} does not reward ${event.type} events`;
  }
  if (event.amountMinor < policy.minEventAmountMinor) {
    return `Sale amount is below the policy minimum (${policy.minEventAmountMinor.toString()})`;
  }
  return null;
}

/** Integer (bigint) division with the requested rounding mode. Operands must be non-negative. */
export function divideRounded(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (numerator < 0n || denominator <= 0n) throw new RangeError('divideRounded expects numerator ≥ 0, denominator > 0');
  const q = numerator / denominator;
  const r = numerator % denominator;
  if (r === 0n || mode === 'DOWN') return q;
  const twice = r * 2n;
  if (twice > denominator) return q + 1n;
  if (twice < denominator) return q;
  // Exactly half.
  if (mode === 'HALF_UP') return q + 1n;
  return q % 2n === 0n ? q : q + 1n; // HALF_EVEN
}

/** Converts the sale amount into the reward unit's minor units (the "base"). */
export function computeBase(amountMinor: bigint, unit: CalcUnit): bigint {
  if (unit.rewardUnit === 'MONEY') return amountMinor;
  const scale = 10n ** BigInt(unit.currencyMinorUnits);
  return (amountMinor * BigInt(unit.pointsPerCurrencyUnit)) / scale;
}

export function computeBudget(baseMinor: bigint, policy: Pick<CalcPolicy, 'budgetBps' | 'maxTotalPerEventMinor'>): bigint {
  const bps = Math.min(Math.max(policy.budgetBps, 0), MAX_BUDGET_BPS);
  let budget = (baseMinor * BigInt(bps)) / BPS_DENOMINATOR;
  if (policy.maxTotalPerEventMinor !== null && policy.maxTotalPerEventMinor < budget) {
    budget = policy.maxTotalPerEventMinor;
  }
  return budget;
}

function ruleAmount(rule: CalcRule, baseMinor: bigint, rounding: RoundingMode): { amount: bigint; capped: boolean } {
  let amount: bigint;
  if (rule.calcType === 'FIXED') {
    amount = rule.fixedAmountMinor ?? 0n;
  } else {
    amount = divideRounded(baseMinor * BigInt(rule.percentageBps ?? 0), BPS_DENOMINATOR, rounding);
  }
  if (rule.capMinor !== null && amount > rule.capMinor) return { amount: rule.capMinor, capped: true };
  return { amount, capped: false };
}

/**
 * Runs the calculation. Callers must have validated the event with `checkEventAgainstPolicy`.
 * Guarantees: Σ allocations ≤ budget; at most one allocation per level and per recipient;
 * only eligible ancestors receive rewards; levels ≤ policy.maxDepth.
 */
export function calculateRewards(input: CalcInput): CalcResult {
  const { event, policy, unit } = input;
  const trace: TraceStep[] = [];
  const warnings: string[] = [];

  const baseMinor = computeBase(event.amountMinor, unit);
  trace.push({
    step: 'base',
    saleAmountMinor: event.amountMinor.toString(),
    rewardUnit: unit.rewardUnit,
    baseMinor: baseMinor.toString(),
    note:
      unit.rewardUnit === 'MONEY'
        ? 'Base equals the sale amount'
        : `Base = floor(sale × ${unit.pointsPerCurrencyUnit} points / 10^${unit.currencyMinorUnits})`,
  });

  const budgetMinor = computeBudget(baseMinor, policy);
  trace.push({
    step: 'budget',
    budgetBps: policy.budgetBps,
    budgetMinor: budgetMinor.toString(),
    maxTotalPerEventMinor: policy.maxTotalPerEventMinor?.toString() ?? null,
  });

  const rulesByLevel = new Map<number, CalcRule>();
  for (const rule of policy.rules) rulesByLevel.set(rule.level, rule);

  const ancestors = [...input.ancestors]
    .filter((a) => a.depth >= 1 && a.depth <= MAX_COMPRESSION_SEARCH_DEPTH)
    .sort((a, b) => a.depth - b.depth);

  const allocations: Allocation[] = [];
  const awardedRecipients = new Set<string>();
  let remaining = budgetMinor;
  let fixedDemand = 0n;

  // Resolve which ancestor fills each level.
  const recipientForLevel = new Map<number, CalcAncestor | { forfeited: CalcAncestor }>();
  if (policy.ineligibleAncestorBehavior === 'FORFEIT') {
    for (const a of ancestors) {
      if (a.depth > policy.maxDepth) break;
      recipientForLevel.set(a.depth, a.eligible ? a : { forfeited: a });
    }
  } else {
    let level = 1;
    for (const a of ancestors) {
      if (level > policy.maxDepth) break;
      if (!a.eligible) continue;
      recipientForLevel.set(level, a);
      level += 1;
    }
  }

  for (let level = 1; level <= policy.maxDepth; level += 1) {
    const rule = rulesByLevel.get(level);
    const slot = recipientForLevel.get(level);

    if (!slot) {
      // FORFEIT: the chain ended. COMPRESS: no further eligible ancestors exist.
      trace.push({ step: 'level', level, decision: 'NO_ANCESTOR', detail: {} });
      break;
    }
    if ('forfeited' in slot) {
      trace.push({
        step: 'level',
        level,
        decision: 'INELIGIBLE_FORFEITED',
        detail: { userId: slot.forfeited.userId, depth: slot.forfeited.depth, reason: slot.forfeited.ineligibleReason ?? 'not eligible' },
      });
      continue;
    }
    if (!rule) {
      trace.push({ step: 'level', level, decision: 'NO_RULE', detail: { userId: slot.userId, depth: slot.depth } });
      continue;
    }
    if (awardedRecipients.has(slot.userId)) {
      // Defensive: a tree never repeats an ancestor, but never pay one person twice per event.
      trace.push({ step: 'level', level, decision: 'ZERO_AMOUNT', detail: { userId: slot.userId, reason: 'duplicate recipient' } });
      continue;
    }

    const { amount: ruleAmountMinor, capped } = ruleAmount(rule, baseMinor, policy.roundingMode);
    if (rule.calcType === 'FIXED') fixedDemand += ruleAmountMinor;

    if (ruleAmountMinor <= 0n) {
      trace.push({ step: 'level', level, decision: 'ZERO_AMOUNT', detail: { userId: slot.userId, depth: slot.depth } });
      continue;
    }
    if (remaining <= 0n) {
      trace.push({
        step: 'level',
        level,
        decision: 'BUDGET_EXHAUSTED',
        detail: { userId: slot.userId, depth: slot.depth, ruleAmountMinor: ruleAmountMinor.toString() },
      });
      continue;
    }

    const amountMinor = ruleAmountMinor <= remaining ? ruleAmountMinor : remaining;
    const budgetLimited = amountMinor < ruleAmountMinor;
    remaining -= amountMinor;
    awardedRecipients.add(slot.userId);
    allocations.push({ level, recipientUserId: slot.userId, depth: slot.depth, ruleAmountMinor, amountMinor, capped, budgetLimited });
    trace.push({
      step: 'level',
      level,
      decision: 'AWARDED',
      detail: {
        userId: slot.userId,
        depth: slot.depth,
        calcType: rule.calcType,
        fixedAmountMinor: rule.fixedAmountMinor?.toString() ?? null,
        percentageBps: rule.percentageBps,
        capMinor: rule.capMinor?.toString() ?? null,
        ruleAmountMinor: ruleAmountMinor.toString(),
        amountMinor: amountMinor.toString(),
        capped,
        budgetLimited,
        remainingBudgetMinor: remaining.toString(),
      },
    });
  }

  const totalAllocatedMinor = budgetMinor - remaining;
  if (allocations.some((a) => a.budgetLimited) || trace.some((t) => t.step === 'level' && t.decision === 'BUDGET_EXHAUSTED')) {
    warnings.push('The reward budget was exhausted; some levels were reduced or skipped.');
  }
  if (fixedDemand > budgetMinor) {
    warnings.push('Fixed reward amounts exceed the budget for this sale amount.');
  }

  return { engineVersion: ENGINE_VERSION, baseMinor, budgetMinor, totalAllocatedMinor, allocations, trace, warnings };
}

/** JSON-safe copy of a result for persistence in reward_calculations.trace. */
export function serializeTrace(result: CalcResult, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    engineVersion: result.engineVersion,
    baseMinor: result.baseMinor.toString(),
    budgetMinor: result.budgetMinor.toString(),
    totalAllocatedMinor: result.totalAllocatedMinor.toString(),
    allocations: result.allocations.map((a) => ({
      ...a,
      ruleAmountMinor: a.ruleAmountMinor.toString(),
      amountMinor: a.amountMinor.toString(),
    })),
    steps: result.trace,
    warnings: result.warnings,
    ...extra,
  };
}
