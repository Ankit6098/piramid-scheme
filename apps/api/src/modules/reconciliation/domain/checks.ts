/**
 * Catalog of reconciliation checks (business rules §11) and the pure parts of the report. The SQL
 * lives in ReconciliationService; most of these are impossible by construction (DB triggers) — the
 * report proves it continuously.
 */
import type {
  ReconciliationCheckDto,
  ReconciliationCheckKey,
  ReconciliationExceptionDto,
  ReconciliationSeverity,
} from '@app/shared';

export interface CheckDefinition {
  key: ReconciliationCheckKey;
  label: string;
  description: string;
  remedy: string;
  severity: ReconciliationSeverity;
}

export const CHECKS: readonly CheckDefinition[] = [
  {
    key: 'REWARD_LEDGER_STATUS_MISMATCH',
    label: 'Reward status matches the ledger',
    description:
      'A POSTED reward must have exactly one posting, a REVERSED reward one posting and one reversal, and any other reward no ledger transactions.',
    remedy: 'Escalate to engineering: the reward and the ledger disagree. Do not approve or reverse the reward until it is investigated.',
    severity: 'critical',
  },
  {
    key: 'LEDGER_AMOUNT_MISMATCH',
    label: 'Ledger amounts equal reward amounts',
    description: 'Every posting and reversal (header and entries) must equal the reward amount, in the reward unit and currency.',
    remedy: 'Escalate to engineering with the transaction id; the ledger is append-only and must be corrected by a reviewed migration.',
    severity: 'critical',
  },
  {
    key: 'UNBALANCED_TRANSACTION',
    label: 'Transactions balance',
    description: 'Debits must equal credits in every ledger transaction (per unit and currency) and match the header entry count and total.',
    remedy: 'Escalate to engineering with the transaction id.',
    severity: 'critical',
  },
  {
    key: 'PAYABLE_BALANCE_MISMATCH',
    label: 'Member balances equal posted rewards',
    description: "Each member's rewards-payable balance must equal the sum of their posted rewards minus reversed rewards.",
    remedy: "Escalate to engineering; compare the member's ledger entries with their reward history.",
    severity: 'critical',
  },
  {
    key: 'REVERSED_EVENT_LIVE_REWARDS',
    label: 'Reversed sales have no live rewards',
    description: 'When a sale is refunded or charged back, every one of its rewards must be rejected or reversed.',
    remedy: 'Reject the pending rewards or reverse the posted ones from the rewards queue, then re-run the report.',
    severity: 'critical',
  },
  {
    key: 'CALCULATION_TOTAL_MISMATCH',
    label: 'Calculations add up',
    description: "A processed sale's calculation total must equal the sum of its rewards (and every processed sale must have a calculation).",
    remedy: 'Escalate to engineering with the sale id; historical calculations are never recalculated.',
    severity: 'critical',
  },
  {
    key: 'EVENT_STUCK_RECEIVED',
    label: 'No sales stuck in processing',
    description: 'Sales should be processed within seconds. These have been waiting for more than 15 minutes.',
    remedy: 'Check that the background worker is running; processing is idempotent and can safely be retried.',
    severity: 'warning',
  },
  {
    key: 'PLAN_PAYMENT_LOOKALIKE',
    label: 'Sales that resemble plan payments',
    description:
      "Sales whose amount equals a plan payment of the credited member, or of a member of their downline, in any program with the sale's currency, recorded within ±2 days of the sale date or of when the sale was recorded. A member's own plan payment — or a recruit's — must never earn rewards.",
    remedy:
      'Review the sale with the program admin. If it is a plan payment, reverse the sale. If it is a genuine sale, resolving or dismissing its plan-payment flag on the Flags page clears it from this queue.',
    severity: 'review',
  },
];

export const CHECK_BY_KEY: ReadonlyMap<ReconciliationCheckKey, CheckDefinition> = new Map(CHECKS.map((c) => [c.key, c]));

export interface CheckOutcome {
  key: ReconciliationCheckKey;
  count: number;
  exceptions: ReconciliationExceptionDto[];
}

/** Check rows in catalog order + the overall health (review items never make the platform unhealthy). */
export function summarizeChecks(outcomes: readonly CheckOutcome[]): {
  checks: ReconciliationCheckDto[];
  totalExceptions: number;
  healthy: boolean;
} {
  const byKey = new Map(outcomes.map((o) => [o.key, o]));
  const checks = CHECKS.map((c): ReconciliationCheckDto => {
    const count = byKey.get(c.key)?.count ?? 0;
    return { ...c, count, passed: count === 0 };
  });
  return {
    checks,
    totalExceptions: checks.reduce((sum, c) => sum + c.count, 0),
    healthy: checks.every((c) => c.passed || c.severity === 'review'),
  };
}
