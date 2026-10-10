// Contracts (Zod request schemas + response types) for the ledger and reconciliation modules
// (business rules §9, §11). The ledger records reward liabilities only — there are no payouts.
//
// Amounts are integer minor units transported as decimal strings; each carries its own unit +
// currency + minor units.

import { z } from 'zod';
import { cursorPageQuerySchema, uuidSchema } from '../api';
import {
  EntryDirection,
  LedgerAccountType,
  LedgerTransactionType,
  RewardStatus,
  RewardUnit,
  type QualifyingEventStatus,
} from '../enums';
import {
  financeDateFilterSchema,
  financeSortOrderSchema,
  type FinanceAmountUnit,
  type FinancePersonRef,
} from './rewards';

// ─── Transactions ───────────────────────────────────────────────────────────

export const ledgerTransactionFiltersSchema = z.object({
  type: z.enum(LedgerTransactionType).optional(),
  /** Posted at ≥ from. */
  from: financeDateFilterSchema.optional(),
  /** Posted at < to. */
  to: financeDateFilterSchema.optional(),
  /** Transactions of rewards credited to this member. */
  memberId: uuidSchema.optional(),
  rewardId: uuidSchema.optional(),
  programId: uuidSchema.optional(),
});
export type LedgerTransactionFilters = z.infer<typeof ledgerTransactionFiltersSchema>;

export const ledgerTransactionListQuerySchema = cursorPageQuerySchema.extend(ledgerTransactionFiltersSchema.shape);
export type LedgerTransactionListQuery = z.infer<typeof ledgerTransactionListQuerySchema>;

export const ledgerExportQuerySchema = ledgerTransactionFiltersSchema.extend({
  order: financeSortOrderSchema.default('desc'),
});
export type LedgerExportQuery = z.infer<typeof ledgerExportQuerySchema>;

export interface LedgerEntryDto extends FinanceAmountUnit {
  id: string;
  accountId: string;
  accountType: LedgerAccountType;
  /** Owner of a member payable account (null for the platform expense account). */
  accountOwner: FinancePersonRef | null;
  direction: EntryDirection;
  amountMinor: string;
}

export interface LedgerTransactionDto extends FinanceAmountUnit {
  id: string;
  type: LedgerTransactionType;
  idempotencyKey: string;
  /** Debit total (= credit total = the reward amount). */
  amountMinor: string;
  entryCount: number;
  description: string | null;
  postedAt: string;
  postedBy: FinancePersonRef | null;
  reward: { id: string; level: number; status: RewardStatus; eventId: string };
  /** Recipient of the reward (owner of the credited / debited payable account). */
  member: FinancePersonRef;
  program: { id: string; name: string };
  /** For a reversal: the posting it compensates. */
  reversesTransactionId: string | null;
  /** For a posting: the reversal that compensated it, if any. */
  reversedByTransactionId: string | null;
}

export interface LedgerTransactionDetailDto extends LedgerTransactionDto {
  entries: LedgerEntryDto[];
}

// ─── Accounts & balances ────────────────────────────────────────────────────

export const ledgerAccountListQuerySchema = cursorPageQuerySchema.extend({
  type: z.enum(LedgerAccountType).optional(),
  memberId: uuidSchema.optional(),
  rewardUnit: z.enum(RewardUnit).optional(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/).optional(),
  /** Only accounts with a non-zero balance. */
  nonZero: z.stringbool().optional(),
});
export type LedgerAccountListQuery = z.infer<typeof ledgerAccountListQuerySchema>;

export interface LedgerAccountDto extends FinanceAmountUnit {
  id: string;
  type: LedgerAccountType;
  owner: FinancePersonRef | null;
  creditsMinor: string;
  debitsMinor: string;
  /**
   * Normal-side balance: credits − debits for member payables (the liability), debits − credits
   * for the platform expense account. Never negative on a consistent ledger.
   */
  balanceMinor: string;
  createdAt: string;
}

export interface LedgerSummaryBucketDto extends FinanceAmountUnit {
  /** Σ posting amounts (every reward ever posted). */
  postedMinor: string;
  postedCount: number;
  /** Σ reversal amounts. */
  reversedMinor: string;
  reversedCount: number;
  /** Σ member payable balances = posted − reversed (reward liabilities recorded, not paid out). */
  outstandingLiabilityMinor: string;
  /** Platform reward expense balance (debits − credits). */
  expenseMinor: string;
  memberAccounts: number;
}

export interface LedgerSummaryDto {
  buckets: LedgerSummaryBucketDto[];
  transactionCount: number;
}

// ─── Reconciliation ─────────────────────────────────────────────────────────

/** Checks of business rules §11. */
export const ReconciliationCheckKey = [
  'REWARD_LEDGER_STATUS_MISMATCH',
  'LEDGER_AMOUNT_MISMATCH',
  'UNBALANCED_TRANSACTION',
  'PAYABLE_BALANCE_MISMATCH',
  'REVERSED_EVENT_LIVE_REWARDS',
  'CALCULATION_TOTAL_MISMATCH',
  'EVENT_STUCK_RECEIVED',
  'PLAN_PAYMENT_LOOKALIKE',
] as const;
export type ReconciliationCheckKey = (typeof ReconciliationCheckKey)[number];

/** critical = money integrity; warning = operational backlog; review = compliance review queue. */
export const ReconciliationSeverity = ['critical', 'warning', 'review'] as const;
export type ReconciliationSeverity = (typeof ReconciliationSeverity)[number];

export const reconciliationQuerySchema = z.object({
  /** Bypass the ~60 s cache. */
  refresh: z.stringbool().optional(),
});
export type ReconciliationQuery = z.infer<typeof reconciliationQuerySchema>;

export interface ReconciliationCheckDto {
  key: ReconciliationCheckKey;
  label: string;
  /** What the check verifies and why it matters. */
  description: string;
  /** What to do when it fails. */
  remedy: string;
  severity: ReconciliationSeverity;
  count: number;
  passed: boolean;
}

export type ReconciliationResourceType =
  | 'reward'
  | 'ledger_transaction'
  | 'ledger_account'
  | 'qualifying_event'
  /** A member whose posted rewards have no payable account at all. */
  | 'member';

export interface ReconciliationExceptionDto {
  check: ReconciliationCheckKey;
  severity: ReconciliationSeverity;
  resourceType: ReconciliationResourceType;
  resourceId: string;
  programId: string | null;
  /** One-line human explanation. */
  summary: string;
  /** Check-specific figures (amounts as decimal strings of minor units). */
  details: Record<string, string | number | boolean | null>;
}

export interface ReconciliationBucketDto extends FinanceAmountUnit {
  /** Σ amounts of rewards ever posted (POSTED + REVERSED). */
  rewardsPostedMinor: string;
  /** Σ posting transactions. */
  ledgerPostedMinor: string;
  /** Σ amounts of REVERSED rewards. */
  rewardsReversedMinor: string;
  /** Σ reversal transactions. */
  ledgerReversedMinor: string;
  /** Σ member payable balances. */
  payableBalanceMinor: string;
  /** Σ POSTED rewards (= posted − reversed). */
  expectedPayableMinor: string;
}

export interface ReconciliationReportDto {
  generatedAt: string;
  /** True when no critical or warning exception exists (review items do not count). */
  healthy: boolean;
  totalExceptions: number;
  checks: ReconciliationCheckDto[];
  /** Up to `exceptionLimitPerCheck` rows per check. */
  exceptions: ReconciliationExceptionDto[];
  exceptionLimitPerCheck: number;
  truncated: boolean;
  summary: {
    rewardsByStatus: Record<RewardStatus, number>;
    eventsByStatus: Record<QualifyingEventStatus, number>;
    buckets: ReconciliationBucketDto[];
  };
}
