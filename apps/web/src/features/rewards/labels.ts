import { formatBps, type RewardStatus } from '@app/shared';

import type { StatusTone } from '@/lib/enum-labels';

/** Calculation-trace decisions per level (reward calculator). */
export const TRACE_DECISION_META: Record<string, { label: string; tone: StatusTone; description: string }> = {
  AWARDED: { label: 'Awarded', tone: 'success', description: 'The level’s rule produced a reward within the budget.' },
  NO_RULE: { label: 'No rule', tone: 'muted', description: 'The policy has no rule for this level.' },
  NO_ANCESTOR: { label: 'No upline', tone: 'muted', description: 'No (further) eligible upline member exists at this level.' },
  INELIGIBLE_FORFEITED: {
    label: 'Forfeited',
    tone: 'warning',
    description: 'The upline member was not eligible at the sale date, so this level was forfeited.',
  },
  BUDGET_EXHAUSTED: { label: 'Budget used up', tone: 'warning', description: 'The sale’s reward budget was already allocated.' },
  ZERO_AMOUNT: { label: 'Zero amount', tone: 'muted', description: 'The rule produced no amount for this sale.' },
};

export function traceDecisionMeta(decision: string) {
  return TRACE_DECISION_META[decision] ?? { label: decision, tone: 'neutral' as StatusTone, description: '' };
}

/** Status tabs of the approval queue, in display order (`ALL` = no status filter). */
export const QUEUE_TABS: ReadonlyArray<{ value: RewardStatus | 'ALL'; label: string }> = [
  { value: 'PENDING_APPROVAL', label: 'Pending approval' },
  { value: 'POSTED', label: 'Posted' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'REVERSED', label: 'Reversed' },
  { value: 'ALL', label: 'All' },
];

/** "10% of base" / "Fixed" description of a level's rule. */
export function ruleLabel(calcType: string | null, percentageBps: number | null): string {
  if (calcType === 'PERCENTAGE' && percentageBps !== null) return `${formatBps(percentageBps)} of base`;
  if (calcType === 'FIXED') return 'Fixed amount';
  return '—';
}

/** Readable audit action names. */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  'event.processed': 'Sale processed',
  'event.rejected': 'Sale rejected at processing',
  'event.reverse': 'Sale reversed',
  'reward.approve': 'Approved and posted',
  'reward.reject': 'Rejected',
  'reward.reverse': 'Reversed',
};

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}
