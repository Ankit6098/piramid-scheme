/**
 * Pure helpers that turn stored policy rows and partial edits into one normalized draft state
 * (bigint amounts), used by save, validate, publish and dry-run alike.
 */
import type {
  IneligibleAncestorBehavior,
  PolicyChangesInput,
  PolicyFields,
  QualifyingEventType,
  RewardCalcType,
  RoundingMode,
} from '@app/shared';
import type { CalcPolicy, CalcRule } from '../../rewards/domain/reward-calculator';

export interface PolicyState {
  name: string;
  notes: string | null;
  triggerEventTypes: QualifyingEventType[];
  maxDepth: number;
  budgetBps: number;
  maxTotalPerEventMinor: bigint | null;
  minEventAmountMinor: bigint;
  pointsPerCurrencyUnit: number;
  ineligibleAncestorBehavior: IneligibleAncestorBehavior;
  roundingMode: RoundingMode;
  requiresApproval: boolean;
  requireActiveEnrollment: boolean;
  rules: CalcRule[];
}

/** Shape of a stored version row (Prisma) needed to build the state. */
export interface PolicyRowLike {
  name: string;
  notes: string | null;
  triggerEventTypes: QualifyingEventType[];
  maxDepth: number;
  budgetBps: number;
  maxTotalPerEventMinor: bigint | null;
  minEventAmountMinor: bigint;
  pointsPerCurrencyUnit: number;
  ineligibleAncestorBehavior: IneligibleAncestorBehavior;
  roundingMode: RoundingMode;
  requiresApproval: boolean;
  requireActiveEnrollment: boolean;
  rules: ReadonlyArray<{
    level: number;
    calcType: RewardCalcType;
    fixedAmountMinor: bigint | null;
    percentageBps: number | null;
    capMinor: bigint | null;
  }>;
}

/** Parsed (zod output) partial changes. */
export type PolicyChanges = Partial<PolicyFields>;
export type { PolicyChangesInput };

export function stateFromRow(row: PolicyRowLike): PolicyState {
  return {
    name: row.name,
    notes: row.notes,
    triggerEventTypes: [...row.triggerEventTypes],
    maxDepth: row.maxDepth,
    budgetBps: row.budgetBps,
    maxTotalPerEventMinor: row.maxTotalPerEventMinor,
    minEventAmountMinor: row.minEventAmountMinor,
    pointsPerCurrencyUnit: row.pointsPerCurrencyUnit,
    ineligibleAncestorBehavior: row.ineligibleAncestorBehavior,
    roundingMode: row.roundingMode,
    requiresApproval: row.requiresApproval,
    requireActiveEnrollment: row.requireActiveEnrollment,
    rules: sortRules(
      row.rules.map((r) => ({
        level: r.level,
        calcType: r.calcType,
        fixedAmountMinor: r.fixedAmountMinor,
        percentageBps: r.percentageBps,
        capMinor: r.capMinor,
      })),
    ),
  };
}

const big = (v: string | null | undefined): bigint | null => (v === null || v === undefined ? null : BigInt(v));

/**
 * Keeps the order of the request so validation issue paths (`rules.<i>.…`) point at the row the
 * client sent; the calculator and storage do not depend on the order.
 */
export function rulesFromInput(rules: PolicyFields['rules']): CalcRule[] {
  return rules.map((r) => ({
    level: r.level,
    calcType: r.calcType,
    fixedAmountMinor: big(r.fixedAmountMinor),
    percentageBps: r.percentageBps,
    capMinor: big(r.capMinor),
  }));
}

/** Applies parsed partial changes over a state (only the keys present change). */
export function applyChanges(state: PolicyState, changes: PolicyChanges | undefined): PolicyState {
  if (!changes) return state;
  const next: PolicyState = { ...state, rules: [...state.rules] };
  if (changes.name !== undefined) next.name = changes.name;
  if (changes.notes !== undefined) next.notes = changes.notes === '' ? null : changes.notes;
  if (changes.triggerEventTypes !== undefined) next.triggerEventTypes = [...changes.triggerEventTypes];
  if (changes.maxDepth !== undefined) next.maxDepth = changes.maxDepth;
  if (changes.budgetBps !== undefined) next.budgetBps = changes.budgetBps;
  if (changes.maxTotalPerEventMinor !== undefined) next.maxTotalPerEventMinor = big(changes.maxTotalPerEventMinor);
  if (changes.minEventAmountMinor !== undefined) next.minEventAmountMinor = BigInt(changes.minEventAmountMinor);
  if (changes.pointsPerCurrencyUnit !== undefined) next.pointsPerCurrencyUnit = changes.pointsPerCurrencyUnit;
  if (changes.ineligibleAncestorBehavior !== undefined) next.ineligibleAncestorBehavior = changes.ineligibleAncestorBehavior;
  if (changes.roundingMode !== undefined) next.roundingMode = changes.roundingMode;
  if (changes.requiresApproval !== undefined) next.requiresApproval = changes.requiresApproval;
  if (changes.requireActiveEnrollment !== undefined) next.requireActiveEnrollment = changes.requireActiveEnrollment;
  if (changes.rules !== undefined) next.rules = rulesFromInput(changes.rules);
  return next;
}

export function sortRules(rules: CalcRule[]): CalcRule[] {
  return [...rules].sort((a, b) => a.level - b.level);
}

/** The calculator's view of a state. */
export function toCalcPolicy(state: PolicyState, identity: { id: string; version: number }): CalcPolicy {
  return {
    id: identity.id,
    version: identity.version,
    maxDepth: state.maxDepth,
    budgetBps: state.budgetBps,
    maxTotalPerEventMinor: state.maxTotalPerEventMinor,
    minEventAmountMinor: state.minEventAmountMinor,
    ineligibleAncestorBehavior: state.ineligibleAncestorBehavior,
    roundingMode: state.roundingMode,
    triggerEventTypes: state.triggerEventTypes,
    rules: state.rules,
  };
}

/** JSON-safe snapshot of a state for audit entries (amounts as strings). */
export function auditSnapshot(state: PolicyState): Record<string, unknown> {
  return {
    name: state.name,
    notes: state.notes,
    triggerEventTypes: state.triggerEventTypes,
    maxDepth: state.maxDepth,
    budgetBps: state.budgetBps,
    maxTotalPerEventMinor: state.maxTotalPerEventMinor?.toString() ?? null,
    minEventAmountMinor: state.minEventAmountMinor.toString(),
    pointsPerCurrencyUnit: state.pointsPerCurrencyUnit,
    ineligibleAncestorBehavior: state.ineligibleAncestorBehavior,
    roundingMode: state.roundingMode,
    requiresApproval: state.requiresApproval,
    requireActiveEnrollment: state.requireActiveEnrollment,
    rules: sortRules(state.rules).map((r) => ({
      level: r.level,
      calcType: r.calcType,
      fixedAmountMinor: r.fixedAmountMinor?.toString() ?? null,
      percentageBps: r.percentageBps,
      capMinor: r.capMinor?.toString() ?? null,
    })),
  };
}

/** Allow-listed audit diff: only the fields whose value changed. */
export function auditDiff(before: PolicyState, after: PolicyState): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const a = auditSnapshot(before);
  const b = auditSnapshot(after);
  const out = { before: {} as Record<string, unknown>, after: {} as Record<string, unknown> };
  for (const key of Object.keys(b)) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      out.before[key] = a[key];
      out.after[key] = b[key];
    }
  }
  return out;
}

/** "Priya N." — first name + last initial (how members see each other, business rules §6). */
export function displayNameOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Member';
  const first = parts[0]!;
  if (parts.length === 1) return first;
  const last = parts[parts.length - 1]!;
  return `${first} ${last.charAt(0).toUpperCase()}.`;
}
