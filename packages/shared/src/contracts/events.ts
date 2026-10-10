// Contracts (Zod request schemas + response types) for the events module (sales intake).
// Business rules §8. A qualifying event is a SALE of the program's approved offering to an end
// customer, credited to a subject member. Plan payments and sign-ups are never sales.
import { z } from 'zod';
import {
  ProgramStatus,
  QualifyingEventSource,
  QualifyingEventStatus,
  QualifyingEventType,
  RewardStatus,
  RewardUnit,
} from '../enums';
import { currencyCodeSchema, cursorPageQuerySchema, isoDateTimeSchema, positiveMinorAmountSchema, uuidSchema } from '../api';
import type { CalcTraceStepDto } from './policies';

/** What happened to a recorded sale (derived from the stored event + calculation). */
export const SaleIntakeOutcome = ['REWARDS_CREATED', 'NO_ELIGIBLE_RECIPIENTS', 'REJECTED', 'PENDING', 'REVERSED'] as const;
export type SaleIntakeOutcome = (typeof SaleIntakeOutcome)[number];

export const SaleCalculationOutcome = ['REWARDS_CREATED', 'NO_ELIGIBLE_RECIPIENTS'] as const;
export type SaleCalculationOutcome = (typeof SaleCalculationOutcome)[number];

// ─── Requests ────────────────────────────────────────────────────────────────

const saleFields = {
  type: z.enum(QualifyingEventType),
  /** The sale's id in the upstream system (order / invoice number). Idempotency: (offering, externalId, revision). */
  externalId: z.string().trim().min(1, 'Enter the order or invoice id').max(128),
  /** End customer of the sale (upstream customer id / invoice party). */
  customerReference: z.string().trim().min(1, 'Enter the end customer reference').max(128),
  /** Member credited with the sale; rewards go to this member's eligible upline. */
  subjectUserId: uuidSchema,
  /** Sale value in the program currency's minor units. */
  amountMinor: positiveMinorAmountSchema,
  /** Optional confirmation of the program currency (a mismatch is refused). */
  currencyCode: currencyCodeSchema.optional(),
  occurredAt: isoDateTimeSchema,
  description: z.string().trim().max(500).optional(),
  /**
   * Re-record of a REJECTED/REVERSED sale: the id of the revision being superseded (optional — a
   * corrected request for the same external id supersedes the latest REJECTED/REVERSED revision anyway).
   */
  supersedesEventId: uuidSchema.optional(),
};

/** POST /admin/events (events:write; optional Idempotency-Key header). */
export const recordSaleSchema = z.object({ programId: uuidSchema, ...saleFields });
export type RecordSaleInput = z.input<typeof recordSaleSchema>;

/** POST /integrations/events (API key). `programId` is optional — the key is scoped to one program. */
export const ingestSaleSchema = z.object({ programId: uuidSchema.optional(), ...saleFields });
export type IngestSaleInput = z.input<typeof ingestSaleSchema>;

export const listSaleEventsQuerySchema = cursorPageQuerySchema.extend({
  programId: uuidSchema.optional(),
  status: z.enum(QualifyingEventStatus).optional(),
  type: z.enum(QualifyingEventType).optional(),
  source: z.enum(QualifyingEventSource).optional(),
  /** occurredAt ≥ from */
  from: isoDateTimeSchema.optional(),
  /** occurredAt < to */
  to: isoDateTimeSchema.optional(),
  /** Exact external id or customer reference. */
  q: z.string().trim().min(1).max(128).optional(),
  subjectUserId: uuidSchema.optional(),
});
export type ListSaleEventsQuery = z.input<typeof listSaleEventsQuerySchema>;

// ─── Responses ───────────────────────────────────────────────────────────────

/** GET /admin/events/programs — programs the caller can see, for filters and the "Record sale" form. */
export interface SaleProgramOptionDto {
  id: string;
  code: string;
  name: string;
  status: ProgramStatus;
  rewardUnit: RewardUnit;
  currencyCode: string;
  currencyMinorUnits: number;
  timezone: string;
  /** The caller holds events:write and write access to this program. */
  canRecordSales: boolean;
}

export interface SaleEventProgramRefDto {
  id: string;
  code: string;
  name: string;
  rewardUnit: RewardUnit;
  currencyCode: string;
  currencyMinorUnits: number;
  timezone: string;
}

export interface SaleEventDto {
  id: string;
  programId: string;
  program: SaleEventProgramRefDto;
  offeringId: string;
  type: QualifyingEventType;
  source: QualifyingEventSource;
  externalId: string;
  revision: number;
  supersedesEventId: string | null;
  supersededByEventId: string | null;
  customerReference: string;
  subject: { id: string; fullName: string };
  /** Sale value in the program currency (minor units). */
  amountMinor: string;
  currencyCode: string;
  occurredAt: string;
  status: QualifyingEventStatus;
  outcome: SaleIntakeOutcome;
  rejectionReason: string | null;
  processedAt: string | null;
  reversedAt: string | null;
  reversalReason: string | null;
  description: string | null;
  policyVersionId: string | null;
  policyVersion: number | null;
  recordedBy: { id: string; fullName: string } | null;
  apiClient: { id: string; name: string; keyPrefix: string } | null;
  /** Rewards created for this sale (any status) and their total in the program reward unit. */
  rewardCount: number;
  rewardTotalMinor: string;
  createdAt: string;
}

export interface SaleEventRewardDto {
  id: string;
  level: number;
  recipient: { id: string; fullName: string };
  amountMinor: string;
  rewardUnit: RewardUnit;
  currencyCode: string;
  status: RewardStatus;
  createdAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  postedAt: string | null;
  reversedAt: string | null;
  rejectionReason: string | null;
  reversalReason: string | null;
}

export interface SaleCalculationAncestorDto {
  userId: string;
  fullName: string | null;
  depth: number;
  eligible: boolean;
  reason: string | null;
}

export interface SaleEventCalculationDto {
  id: string;
  outcome: SaleCalculationOutcome;
  rewardUnit: RewardUnit;
  currencyCode: string;
  currencyMinorUnits: number;
  pointsPerCurrencyUnit: number;
  baseMinor: string;
  budgetBps: number;
  budgetMinor: string;
  totalAllocatedMinor: string;
  engineVersion: string;
  createdAt: string;
  /** Ancestors the engine considered, with eligibility decisions at the sale instant. */
  ancestors: SaleCalculationAncestorDto[];
  steps: CalcTraceStepDto[];
  warnings: string[];
}

export interface SaleEventRevisionDto {
  id: string;
  revision: number;
  status: QualifyingEventStatus;
  createdAt: string;
}

/** GET /admin/events/:id (admin-only: never shown to members). */
export interface SaleEventDetailDto extends SaleEventDto {
  calculation: SaleEventCalculationDto | null;
  rewards: SaleEventRewardDto[];
  /** All revisions of this sale (same offering + external id), oldest first. */
  revisions: SaleEventRevisionDto[];
}

/** POST /admin/events → 201 (new) or 200 (replay of an identical request). */
export interface RecordSaleResultDto {
  event: SaleEventDetailDto;
  outcome: SaleIntakeOutcome;
  replayed: boolean;
}

/** POST /integrations/events → 201 / 200. Deliberately minimal: no member or reward details. */
export interface IntegrationSaleResultDto {
  id: string;
  programId: string;
  externalId: string;
  revision: number;
  type: QualifyingEventType;
  amountMinor: string;
  currencyCode: string;
  occurredAt: string;
  status: QualifyingEventStatus;
  outcome: SaleIntakeOutcome;
  rejectionReason: string | null;
  createdAt: string;
  replayed: boolean;
}
