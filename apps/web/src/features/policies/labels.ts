/**
 * Labels + tones for policy-specific enumerations that are not part of the global enum table
 * (`PolicyPhase`, `CalcLevelDecision`), plus human labels for validation issue paths.
 */
import type { CalcLevelDecision, PolicyPhase } from '@app/shared';

import type { EnumMeta } from '@/lib/enum-labels';

export const POLICY_PHASE_META: Record<PolicyPhase, EnumMeta> = {
  DRAFT: {
    label: 'Draft',
    tone: 'neutral',
    description: 'Editable. Not in effect until it is published.',
  },
  SCHEDULED: {
    label: 'Scheduled',
    tone: 'info',
    description: 'Published. Takes effect automatically at its start time.',
  },
  CURRENT: {
    label: 'In effect',
    tone: 'success',
    description: 'Prices qualifying sales right now.',
  },
  ENDED: {
    label: 'Ended',
    tone: 'muted',
    description: 'Closed when a newer version took effect.',
  },
  RETIRED: { label: 'Retired', tone: 'muted', description: 'Retired after it had taken effect.' },
  WITHDRAWN: {
    label: 'Withdrawn',
    tone: 'destructive-outline',
    description: 'Retired before it took effect, so it never applied to any sale.',
  },
};

export const LEVEL_DECISION_META: Record<CalcLevelDecision, EnumMeta> = {
  AWARDED: { label: 'Awarded', tone: 'success' },
  NO_RULE: { label: 'No rule for this level', tone: 'muted' },
  NO_ANCESTOR: { label: 'No upline member', tone: 'muted' },
  INELIGIBLE_FORFEITED: { label: 'Ineligible – forfeited', tone: 'warning' },
  BUDGET_EXHAUSTED: { label: 'Budget exhausted', tone: 'warning' },
  ZERO_AMOUNT: { label: 'Zero amount', tone: 'muted' },
};

export function phaseMeta(phase: PolicyPhase | string): EnumMeta {
  return POLICY_PHASE_META[phase as PolicyPhase] ?? { label: phase, tone: 'neutral' };
}

export function decisionMeta(decision: CalcLevelDecision | string): EnumMeta {
  return LEVEL_DECISION_META[decision as CalcLevelDecision] ?? { label: decision, tone: 'neutral' };
}

export function approvalModeLabel(requiresApproval: boolean): string {
  return requiresApproval ? 'Manual approval' : 'Auto-approves API & webhook sales';
}

const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  notes: 'Notes',
  triggerEventTypes: 'Qualifying sale types',
  maxDepth: 'Maximum depth',
  budgetBps: 'Total reward budget',
  maxTotalPerEventMinor: 'Maximum total per sale',
  minEventAmountMinor: 'Minimum sale amount',
  pointsPerCurrencyUnit: 'Points rate',
  ineligibleAncestorBehavior: 'Ineligible upline members',
  roundingMode: 'Rounding',
  requiresApproval: 'Manual approval',
  requireActiveEnrollment: 'Active enrollment requirement',
  rules: 'Reward levels',
  effectiveFrom: 'Effective start',
  effectiveTo: 'Effective end',
  program: 'Program',
  policy: 'Policy',
};

const RULE_FIELD_LABELS: Record<string, string> = {
  level: 'level number',
  calcType: 'type',
  fixedAmountMinor: 'fixed amount',
  percentageBps: 'percentage',
  capMinor: 'cap',
};

function humanizePath(path: string): string {
  const words = path
    .replace(/\./g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Policy';
}

/**
 * Human label for an issue path from the validate/publish endpoints (`budgetBps`,
 * `rules.0.percentageBps`, `effectiveFrom`, …). `rules` lets rule rows show their level number.
 */
export function issueFieldLabel(
  path: string,
  rules?: ReadonlyArray<{ level?: unknown } | undefined>,
): string {
  if (!path) return 'Policy';
  const ruleMatch = /^rules\.(\d+)(?:\.(\w+))?$/.exec(path);
  if (ruleMatch) {
    const index = Number(ruleMatch[1]);
    const level = rules?.[index]?.level;
    const row = typeof level === 'number' ? `Level ${level}` : `Reward level row ${index + 1}`;
    const field = ruleMatch[2]
      ? (RULE_FIELD_LABELS[ruleMatch[2]] ?? humanizePath(ruleMatch[2]))
      : null;
    return field ? `${row} – ${field}` : row;
  }
  return FIELD_LABELS[path] ?? humanizePath(path);
}
