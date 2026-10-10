// Contracts (Zod request schemas + response types) for the rewards module: the admin approval
// queue, reward decisions (approve / reject / bulk approve / reverse), event reversal, member reward
// history and earnings (business rules §9, §10).
//
// Amounts are integer minor units transported as decimal strings ("150000"); every amount travels
// with its own `rewardUnit` + `currencyCode` + `currencyMinorUnits` — format with formatAmount().
// Names are prefixed (Finance…, AdminReward…, MemberReward…) because every contract file is
// re-exported from the package root.

import { z } from 'zod';
import { cursorPageQuerySchema, reasonSchema, uuidSchema } from '../api';
import {
  QualifyingEventSource,
  QualifyingEventStatus,
  QualifyingEventType,
  RewardStatus,
  type LedgerTransactionType,
  type RewardCalcType,
  type RewardUnit,
} from '../enums';
import type { LedgerTransactionDetailDto } from './ledger';

// ─── Shared building blocks (also used by the ledger contracts) ─────────────

/** Max ids in one bulk-approve request. */
export const MAX_BULK_APPROVE = 100;

/**
 * Reasons for rejections and reversals. Stored on the reward / event (≤ 500 chars; an event reversal
 * prefixes "Sale reversed: "), so the limit is tighter than the generic `reasonSchema`.
 */
export const financeReasonSchema = reasonSchema.max(480, 'Keep the reason under 480 characters');

/**
 * Date filter: an ISO date-time with offset, or a calendar date (`YYYY-MM-DD`, UTC: `from` = start
 * of that day, `to` = end of that day). `from` is inclusive; a date-time `to` is exclusive.
 */
export const financeDateFilterSchema = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);

export const financeSortOrderSchema = z.enum(['asc', 'desc']);

/** Who did something (admin views). */
export interface FinancePersonRef {
  id: string;
  fullName: string;
}

export interface FinanceProgramRef {
  id: string;
  name: string;
  code: string;
  /** IANA zone the program's dates are displayed in. */
  timezone: string;
}

/** Unit + currency snapshot that travels with every amount. */
export interface FinanceAmountUnit {
  rewardUnit: RewardUnit;
  currencyCode: string;
  /** Minor units of `currencyCode` (POINTS amounts are formatted with 0). */
  currencyMinorUnits: number;
}

/** 409 CONFLICT `details.reason` when a decision would break segregation of duties. */
export const REWARD_SOD_CONFLICT_REASON = 'SEGREGATION_OF_DUTIES';
export const RewardSodRule = {
  OwnReward: 'OWN_REWARD',
  RecordedSale: 'RECORDED_SALE',
} as const;
export type RewardSodRule = (typeof RewardSodRule)[keyof typeof RewardSodRule];

/** reward_calculations.outcome */
export const RewardCalculationOutcome = ['REWARDS_CREATED', 'NO_ELIGIBLE_RECIPIENTS'] as const;
export type RewardCalculationOutcome = (typeof RewardCalculationOutcome)[number];

// ─── Admin: list / counts / facets ──────────────────────────────────────────

export const adminRewardFiltersSchema = z.object({
  status: z.enum(RewardStatus).optional(),
  programId: uuidSchema.optional(),
  recipientUserId: uuidSchema.optional(),
  eventId: uuidSchema.optional(),
  level: z.coerce.number().int().min(1).max(10).optional(),
  /** Created at ≥ from. */
  from: financeDateFilterSchema.optional(),
  /** Created at < to. */
  to: financeDateFilterSchema.optional(),
  /** Recipient name or email contains (case-insensitive). */
  q: z.string().trim().min(1).max(100).optional(),
});
export type AdminRewardFilters = z.infer<typeof adminRewardFiltersSchema>;

export const adminRewardListQuerySchema = cursorPageQuerySchema.extend({
  ...adminRewardFiltersSchema.shape,
  /** By creation time; `asc` = oldest first (approval queue). Default `desc`. */
  order: financeSortOrderSchema.default('desc'),
});
export type AdminRewardListQuery = z.infer<typeof adminRewardListQuerySchema>;

/** CSV export filters (the list filters without the cursor). */
export const adminRewardExportQuerySchema = adminRewardFiltersSchema.extend({
  order: financeSortOrderSchema.default('desc'),
});
export type AdminRewardExportQuery = z.infer<typeof adminRewardExportQuerySchema>;

/** Counts per status for the queue tabs (`status` is not a filter here). */
export const adminRewardCountsQuerySchema = adminRewardFiltersSchema.omit({ status: true });
export type AdminRewardCountsQuery = z.infer<typeof adminRewardCountsQuerySchema>;

export interface AdminRewardCountsDto {
  byStatus: Record<RewardStatus, number>;
  total: number;
}

export interface AdminRewardFacetsDto {
  /** Programs the viewer may see that have rewards. */
  programs: FinanceProgramRef[];
}

export interface AdminRewardEventDto {
  id: string;
  externalId: string;
  revision: number;
  type: QualifyingEventType;
  source: QualifyingEventSource;
  status: QualifyingEventStatus;
  /** Sale value in currency minor units (`currencyCode`). */
  amountMinor: string;
  currencyCode: string;
  occurredAt: string;
  subject: FinancePersonRef;
  recordedBy: FinancePersonRef | null;
}

/** Segregation-of-duties hints for the current viewer (the server enforces them regardless). */
export interface AdminRewardViewerHints {
  /** The viewer is the recipient: they may not approve, reject or reverse it. */
  isRecipient: boolean;
  /** The viewer recorded the sale: they may not approve its rewards. */
  recordedSale: boolean;
}

export interface AdminRewardRowDto extends FinanceAmountUnit {
  id: string;
  status: RewardStatus;
  level: number;
  amountMinor: string;
  program: FinanceProgramRef;
  recipient: FinancePersonRef;
  event: AdminRewardEventDto;
  createdAt: string;
  approvedAt: string | null;
  approvedBy: FinancePersonRef | null;
  postedAt: string | null;
  rejectedAt: string | null;
  rejectedBy: FinancePersonRef | null;
  rejectionReason: string | null;
  reversedAt: string | null;
  reversedBy: FinancePersonRef | null;
  reversalReason: string | null;
  viewer: AdminRewardViewerHints;
}

// ─── Admin: detail (calculation trace) ──────────────────────────────────────

/** Engine decisions per level. Older traces may contain other values. */
export const RewardTraceDecision = [
  'AWARDED',
  'NO_RULE',
  'NO_ANCESTOR',
  'INELIGIBLE_FORFEITED',
  'BUDGET_EXHAUSTED',
  'ZERO_AMOUNT',
] as const;
export type RewardTraceDecision = (typeof RewardTraceDecision)[number];

export interface AdminRewardTraceLevelDto {
  level: number;
  decision: RewardTraceDecision | (string & {});
  user: FinancePersonRef | null;
  depth: number | null;
  calcType: RewardCalcType | null;
  percentageBps: number | null;
  fixedAmountMinor: string | null;
  capMinor: string | null;
  /** Rule amount after rounding and the per-level cap, before the budget. */
  ruleAmountMinor: string | null;
  /** Final amount (AWARDED only). */
  amountMinor: string | null;
  capped: boolean;
  budgetLimited: boolean;
  remainingBudgetMinor: string | null;
  /** Why an ancestor was skipped (ineligible, duplicate, …). */
  reason: string | null;
  /** This level produced the reward being viewed. */
  isThisReward: boolean;
}

export interface AdminRewardTraceAncestorDto {
  userId: string;
  user: FinancePersonRef | null;
  depth: number;
  eligible: boolean;
  reason: string | null;
}

/** Readable form of `reward_calculations.trace` (admin-only). */
export interface AdminRewardTraceDto {
  /** False when the stored trace could not be interpreted (`raw` is still returned). */
  parsed: boolean;
  engineVersion: string | null;
  saleAmountMinor: string | null;
  baseNote: string | null;
  baseMinor: string | null;
  budgetBps: number | null;
  budgetMinor: string | null;
  maxTotalPerEventMinor: string | null;
  totalAllocatedMinor: string | null;
  policyVersion: number | null;
  levels: AdminRewardTraceLevelDto[];
  ancestors: AdminRewardTraceAncestorDto[];
  warnings: string[];
  raw: unknown;
}

export interface AdminRewardCalculationDto extends FinanceAmountUnit {
  id: string;
  outcome: RewardCalculationOutcome;
  engineVersion: string;
  pointsPerCurrencyUnit: number;
  baseMinor: string;
  budgetBps: number;
  budgetMinor: string;
  totalAllocatedMinor: string;
  createdAt: string;
  trace: AdminRewardTraceDto;
}

export interface AdminRewardSiblingDto extends FinanceAmountUnit {
  id: string;
  level: number;
  status: RewardStatus;
  amountMinor: string;
  recipient: FinancePersonRef;
}

export interface AdminRewardAuditEntryDto {
  id: string;
  action: string;
  resourceType: string;
  actor: FinancePersonRef | null;
  actorRoles: string[];
  reason: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export interface AdminRewardDetailDto extends Omit<AdminRewardRowDto, 'event'> {
  event: AdminRewardEventDto & {
    customerReference: string;
    description: string | null;
    processedAt: string | null;
    reversedAt: string | null;
    reversalReason: string | null;
  };
  policyVersion: { id: string; version: number; name: string; requiresApproval: boolean };
  calculation: AdminRewardCalculationDto;
  /** Other rewards created from the same sale. */
  siblings: AdminRewardSiblingDto[];
  ledgerTransactions: LedgerTransactionDetailDto[];
  /** Reward and sale audit entries, oldest first. */
  auditTrail: AdminRewardAuditEntryDto[];
}

// ─── Admin: decisions ───────────────────────────────────────────────────────

export const rejectRewardSchema = z.object({ reason: financeReasonSchema });
export type RejectRewardInput = z.infer<typeof rejectRewardSchema>;

export const reverseRewardSchema = z.object({ reason: financeReasonSchema });
export type ReverseRewardInput = z.infer<typeof reverseRewardSchema>;

export const bulkApproveRewardsSchema = z.object({
  ids: z
    .array(uuidSchema)
    .min(1, 'Select at least one reward')
    .max(MAX_BULK_APPROVE, `At most ${MAX_BULK_APPROVE} rewards at a time`)
    .refine((ids) => new Set(ids).size === ids.length, 'Each reward may appear only once'),
});
export type BulkApproveRewardsInput = z.infer<typeof bulkApproveRewardsSchema>;

/** Result of approve / reject / reverse. */
export interface RewardDecisionResultDto {
  id: string;
  status: RewardStatus;
  /** Ledger transaction written by this decision (posting or reversal). */
  ledgerTransaction: { id: string; type: LedgerTransactionType } | null;
}

export type BulkApproveItemResultDto =
  | { id: string; ok: true; status: RewardStatus; ledgerTransactionId: string }
  | { id: string; ok: false; error: { code: string; message: string } };

export interface BulkApproveResultDto {
  results: BulkApproveItemResultDto[];
  approved: number;
  failed: number;
}

// ─── Admin: event reversal (POST /admin/events/:id/reverse) ─────────────────

export const eventReversalSchema = z.object({ reason: financeReasonSchema });
export type EventReversalInput = z.infer<typeof eventReversalSchema>;

export interface EventReversalResultDto {
  eventId: string;
  status: QualifyingEventStatus;
  reversedAt: string;
  /** PENDING_APPROVAL / APPROVED rewards that were rejected. */
  rejectedRewardIds: string[];
  /** POSTED rewards reversed with a compensating ledger transaction. */
  reversedRewardIds: string[];
}

// ─── Member ─────────────────────────────────────────────────────────────────

export const memberRewardFiltersSchema = z.object({
  status: z.enum(RewardStatus).optional(),
  programId: uuidSchema.optional(),
  from: financeDateFilterSchema.optional(),
  to: financeDateFilterSchema.optional(),
});
export type MemberRewardFilters = z.infer<typeof memberRewardFiltersSchema>;

export const memberRewardListQuerySchema = cursorPageQuerySchema.extend(memberRewardFiltersSchema.shape);
export type MemberRewardListQuery = z.infer<typeof memberRewardListQuerySchema>;

/**
 * What a member sees about one of their rewards (business rules §10). Deliberately excludes the
 * sale's subject, sale amount, exact sale time, external id, customer reference and the trace.
 * Dates are calendar dates (`YYYY-MM-DD`) in the program's time zone.
 */
export interface MemberRewardDto extends FinanceAmountUnit {
  id: string;
  program: { id: string; name: string };
  level: number;
  amountMinor: string;
  status: RewardStatus;
  createdDate: string;
  approvedDate: string | null;
  postedDate: string | null;
  rejectedDate: string | null;
  reversedDate: string | null;
  rejectionReason: string | null;
  reversalReason: string | null;
}

export interface MemberRewardFacetsDto {
  programs: Array<{ id: string; name: string }>;
}

/**
 * One (unit, currency) bucket of a member's earnings:
 * earnedToDate = Σ credits − Σ debits on the member's payable ledger accounts (posted − reversed);
 * pending = Σ PENDING_APPROVAL + APPROVED rewards; reversed = Σ REVERSED rewards.
 * Rejected rewards are never totalled.
 */
export interface EarningsBucketDto extends FinanceAmountUnit {
  earnedToDateMinor: string;
  pendingMinor: string;
  reversedMinor: string;
  postedCount: number;
  pendingCount: number;
  reversedCount: number;
}

export interface MemberEarningsDto {
  buckets: EarningsBucketDto[];
}
