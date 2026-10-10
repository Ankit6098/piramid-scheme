// Contracts (Zod request schemas + response types) for the programs module: programs, options
// (plans), lifecycle, admin assignments and the member-facing catalogue (docs/business-rules.md §1,
// §4). The pure rule helpers below are shared by the API (authoritative) and the web forms.
import { z } from 'zod';
import { cursorPageQuerySchema, isoDateTimeSchema, minorAmountSchema, reasonSchema } from '../api';
import {
  BillingFrequency,
  EnrollmentStatus,
  OfferingKind,
  OfferingStatus,
  ProgramStatus,
  RenewalPolicy,
  RewardUnit,
} from '../enums';
import type { CatalogUserRef } from './settings';

// ─── Shared rules (pure) ────────────────────────────────────────────────────

/** Program slug, e.g. `spring-2027` (DB CHECK `ck_programs_code_slug`). */
export const PROGRAM_CODE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** True for an IANA time zone the runtime knows (e.g. "Asia/Kolkata"). */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Allowed option durations (days) per billing frequency (business rules §4). */
export const OPTION_DURATION_RANGES: Readonly<Record<BillingFrequency, { min: number; max: number }>> = {
  ONE_TIME: { min: 1, max: 3660 },
  MONTHLY: { min: 28, max: 31 },
  QUARTERLY: { min: 89, max: 92 },
  HALF_YEARLY: { min: 181, max: 184 },
  YEARLY: { min: 365, max: 366 },
};

/** Suggested duration when a frequency is picked in a form. */
export const DEFAULT_OPTION_DURATION: Readonly<Record<BillingFrequency, number>> = {
  ONE_TIME: 365,
  MONTHLY: 30,
  QUARTERLY: 91,
  HALF_YEARLY: 182,
  YEARLY: 365,
};

/**
 * Checks that an option's duration is consistent with its billing frequency.
 * @returns a user-facing message, or null when valid.
 */
export function optionDurationIssue(frequency: BillingFrequency, durationDays: number): string | null {
  if (!Number.isInteger(durationDays)) return 'Duration must be a whole number of days';
  const range = OPTION_DURATION_RANGES[frequency];
  if (durationDays < range.min || durationDays > range.max) {
    return range.min === 1
      ? `Duration must be between 1 and ${range.max} days`
      : `A ${frequency.toLowerCase().replace('_', '-')} plan lasts ${range.min}–${range.max} days`;
  }
  return null;
}

export interface ProgramDateInput {
  startsAt: string | Date;
  endsAt?: string | Date | null;
  enrollmentOpensAt: string | Date;
  enrollmentClosesAt?: string | Date | null;
}

export interface FieldIssue {
  path: string;
  message: string;
}

const ms = (v: string | Date) => (v instanceof Date ? v.getTime() : Date.parse(v));

/**
 * Date consistency (DB CHECKs): `startsAt < endsAt`, `enrollmentOpensAt < enrollmentClosesAt`,
 * `enrollmentOpensAt < endsAt` and `enrollmentClosesAt ≤ endsAt`. Returns field issues (empty = valid).
 */
export function programDateIssues(d: ProgramDateInput): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const starts = ms(d.startsAt);
  const opens = ms(d.enrollmentOpensAt);
  const ends = d.endsAt ? ms(d.endsAt) : null;
  const closes = d.enrollmentClosesAt ? ms(d.enrollmentClosesAt) : null;
  if (ends !== null && !(ends > starts)) issues.push({ path: 'endsAt', message: 'The end must be after the start' });
  if (closes !== null && !(closes > opens)) {
    issues.push({ path: 'enrollmentClosesAt', message: 'Enrollment must close after it opens' });
  }
  if (ends !== null && !(opens < ends)) {
    issues.push({ path: 'enrollmentOpensAt', message: 'Enrollment must open before the program ends' });
  }
  if (ends !== null && closes !== null && closes > ends) {
    issues.push({ path: 'enrollmentClosesAt', message: 'Enrollment must close by the program end' });
  }
  return issues;
}

/** Program fields an admin can edit (`PATCH /admin/programs/:id`). */
export const ProgramEditableField = [
  'code',
  'name',
  'description',
  'offeringId',
  'timezone',
  'startsAt',
  'endsAt',
  'enrollmentOpensAt',
  'enrollmentClosesAt',
  'maxRewardDepth',
  'lateEventGraceDays',
  'eligibility',
  'termsVersion',
  'termsText',
] as const;
export type ProgramEditableField = (typeof ProgramEditableField)[number];

const PUBLISHED_TEXT_FIELDS: readonly ProgramEditableField[] = ['name', 'description', 'termsVersion', 'termsText'];

/**
 * Which fields may change in each status (business rules §4): everything while DRAFT; after
 * publication only name, description, terms (with a new version) and — until completion — the end
 * and enrollment close dates; the start (and enrollment opening) only until the program starts.
 * Archived programs are read-only.
 */
export function programEditableFields(status: ProgramStatus): readonly ProgramEditableField[] {
  switch (status) {
    case 'DRAFT':
      return ProgramEditableField;
    case 'SCHEDULED':
      return [...PUBLISHED_TEXT_FIELDS, 'startsAt', 'enrollmentOpensAt', 'endsAt', 'enrollmentClosesAt'];
    case 'ACTIVE':
    case 'PAUSED':
      return [...PUBLISHED_TEXT_FIELDS, 'endsAt', 'enrollmentClosesAt'];
    case 'COMPLETED':
      return PUBLISHED_TEXT_FIELDS;
    case 'ARCHIVED':
      return [];
  }
}

/** Manual lifecycle actions (`POST /admin/programs/:id/<action>`). */
export const ProgramLifecycleAction = ['publish', 'pause', 'resume', 'complete', 'archive', 'cancel'] as const;
export type ProgramLifecycleAction = (typeof ProgramLifecycleAction)[number];

/**
 * Manual transitions (DB state machine). SCHEDULED → ACTIVE (at `startsAt`) and ACTIVE/PAUSED →
 * COMPLETED (at `endsAt`) also happen automatically.
 */
export const PROGRAM_LIFECYCLE_RULES: Readonly<
  Record<ProgramLifecycleAction, { from: readonly ProgramStatus[]; reasonRequired: boolean }>
> = {
  publish: { from: ['DRAFT'], reasonRequired: false },
  pause: { from: ['ACTIVE'], reasonRequired: true },
  resume: { from: ['PAUSED'], reasonRequired: false },
  complete: { from: ['ACTIVE', 'PAUSED'], reasonRequired: false },
  archive: { from: ['COMPLETED'], reasonRequired: false },
  /** Withdraw a SCHEDULED program before its start date (→ ARCHIVED). */
  cancel: { from: ['SCHEDULED'], reasonRequired: true },
};

export function programLifecycleActions(status: ProgramStatus): ProgramLifecycleAction[] {
  return ProgramLifecycleAction.filter((a) => PROGRAM_LIFECYCLE_RULES[a].from.includes(status));
}

/** Statuses in which a program is "live" (published, not finished). */
export const LIVE_PROGRAM_STATUSES: readonly ProgramStatus[] = ['SCHEDULED', 'ACTIVE', 'PAUSED'];

// ─── Requests ───────────────────────────────────────────────────────────────

export const programEligibilitySchema = z.strictObject({
  /** Members must have had an account for at least this many days. */
  minAccountAgeDays: z.number().int().min(0).max(3650).optional(),
  /** Members must have joined through a referral (have a sponsor). */
  requireSponsor: z.boolean().optional(),
});
export type ProgramEligibility = z.infer<typeof programEligibilitySchema>;

const programFields = {
  code: z
    .string()
    .trim()
    .min(3, 'Use at least 3 characters')
    .max(64)
    .regex(PROGRAM_CODE_PATTERN, 'Use lowercase letters, digits and single hyphens (e.g. spring-2027)'),
  name: z.string().trim().min(2, 'Enter at least 2 characters').max(160),
  description: z.string().trim().max(5000).nullish(),
  offeringId: z.uuid('Choose an offering'),
  timezone: z.string().trim().refine(isValidTimeZone, 'Choose a valid time zone'),
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema.nullish(),
  enrollmentOpensAt: isoDateTimeSchema,
  enrollmentClosesAt: isoDateTimeSchema.nullish(),
  maxRewardDepth: z.number().int().min(1).max(10),
  lateEventGraceDays: z.number().int().min(0).max(365),
  eligibility: programEligibilitySchema,
  termsVersion: z.string().trim().min(1, 'Enter a terms version').max(32),
  termsText: z.string().trim().max(50_000).nullish(),
};

/**
 * `POST /admin/programs` — creates a DRAFT and snapshots the platform reward unit + currency.
 * `enrollmentOpensAt` defaults to `startsAt`.
 */
export const createProgramSchema = z
  .object({
    ...programFields,
    enrollmentOpensAt: programFields.enrollmentOpensAt.optional(),
    timezone: programFields.timezone.default('Asia/Kolkata'),
    maxRewardDepth: programFields.maxRewardDepth.default(5),
    lateEventGraceDays: programFields.lateEventGraceDays.default(30),
    eligibility: programFields.eligibility.default({}),
    termsVersion: programFields.termsVersion.default('1.0'),
  })
  .superRefine((v, ctx) => {
    for (const issue of programDateIssues({ ...v, enrollmentOpensAt: v.enrollmentOpensAt ?? v.startsAt })) {
      ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
    }
  });
export type CreateProgramInput = z.input<typeof createProgramSchema>;

/**
 * `PATCH /admin/programs/:id` — send only changed fields plus `expectedVersion`. Fields outside
 * `programEditableFields(status)` are rejected (409). Changing the terms text of a published
 * program requires a new `termsVersion`.
 */
export const updateProgramSchema = z.object({
  expectedVersion: z.number().int().min(1),
  code: programFields.code.optional(),
  name: programFields.name.optional(),
  description: programFields.description,
  offeringId: programFields.offeringId.optional(),
  timezone: programFields.timezone.optional(),
  startsAt: programFields.startsAt.optional(),
  endsAt: programFields.endsAt,
  enrollmentOpensAt: programFields.enrollmentOpensAt.optional(),
  enrollmentClosesAt: programFields.enrollmentClosesAt,
  maxRewardDepth: programFields.maxRewardDepth.optional(),
  lateEventGraceDays: programFields.lateEventGraceDays.optional(),
  eligibility: programFields.eligibility.optional(),
  termsVersion: programFields.termsVersion.optional(),
  termsText: programFields.termsText,
  /** Optional note for the audit log. */
  reason: reasonSchema.optional(),
});
export type UpdateProgramInput = z.infer<typeof updateProgramSchema>;

/** Body of publish / resume / complete / archive (reason optional, recorded in the timeline). */
export const programLifecycleSchema = z.object({
  expectedVersion: z.number().int().min(1).optional(),
  reason: reasonSchema.optional(),
});
export type ProgramLifecycleInput = z.infer<typeof programLifecycleSchema>;

/** Body of pause (reason required). */
export const pauseProgramSchema = z.object({
  expectedVersion: z.number().int().min(1).optional(),
  reason: reasonSchema,
});
export type PauseProgramInput = z.infer<typeof pauseProgramSchema>;

/** Body of cancel (SCHEDULED → ARCHIVED before the start date; reason required). */
export const cancelProgramSchema = pauseProgramSchema;
export type CancelProgramInput = z.infer<typeof cancelProgramSchema>;

const statusFilter = z.union([z.enum(ProgramStatus), z.array(z.enum(ProgramStatus)).max(ProgramStatus.length)]);

/** `GET /admin/programs` — newest first. PROGRAM_ADMINs only see programs assigned to them. */
export const listAdminProgramsQuerySchema = cursorPageQuerySchema.extend({
  /** One status or several (`?status=ACTIVE&status=PAUSED`). */
  status: statusFilter.optional(),
  offeringId: z.uuid().optional(),
  /** Case-insensitive match on name or code. */
  q: z.string().trim().max(100).optional(),
});
export type ListAdminProgramsQuery = z.infer<typeof listAdminProgramsQuerySchema>;

const optionFields = {
  name: z.string().trim().min(1, 'Enter a name').max(120),
  description: z.string().trim().max(1000).nullish(),
  /** Price in minor units of the program currency (0 = free). The price buys the plan; it earns nothing. */
  priceMinor: minorAmountSchema,
  billingFrequency: z.enum(BillingFrequency),
  durationDays: z.number().int('Use whole days').min(1).max(3660),
  renewalPolicy: z.enum(RenewalPolicy),
  sortOrder: z.number().int().min(0).max(10_000),
};

/** `POST /admin/programs/:id/options`. */
export const createProgramOptionSchema = z
  .object({
    ...optionFields,
    renewalPolicy: optionFields.renewalPolicy.default('MANUAL'),
    sortOrder: optionFields.sortOrder.optional(),
  })
  .superRefine((v, ctx) => {
    const issue = optionDurationIssue(v.billingFrequency, v.durationDays);
    if (issue) ctx.addIssue({ code: 'custom', path: ['durationDays'], message: issue });
  });
export type CreateProgramOptionInput = z.input<typeof createProgramOptionSchema>;

/**
 * `PATCH /admin/programs/:id/options/:optionId`. Price, duration and billing frequency of an
 * option that already has enrollments never change (409 — create a new option instead).
 */
export const updateProgramOptionSchema = z
  .object({
    name: optionFields.name.optional(),
    description: optionFields.description,
    priceMinor: optionFields.priceMinor.optional(),
    billingFrequency: optionFields.billingFrequency.optional(),
    durationDays: optionFields.durationDays.optional(),
    renewalPolicy: optionFields.renewalPolicy.optional(),
    sortOrder: optionFields.sortOrder.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Change at least one field' });
export type UpdateProgramOptionInput = z.infer<typeof updateProgramOptionSchema>;

/** `PUT /admin/programs/:id/admins` — replaces the set of assigned PROGRAM_ADMINs. */
export const setProgramAdminsSchema = z.object({
  userIds: z
    .array(z.uuid())
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'Each admin can be listed only once'),
  reason: reasonSchema.optional(),
});
export type SetProgramAdminsInput = z.infer<typeof setProgramAdminsSchema>;

/** `GET /programs` (member catalogue). */
export const listMemberProgramsQuerySchema = cursorPageQuerySchema;
export type ListMemberProgramsQuery = z.infer<typeof listMemberProgramsQuerySchema>;

// ─── Responses ──────────────────────────────────────────────────────────────

export interface ProgramOfferingRef {
  id: string;
  name: string;
  kind: OfferingKind;
  status: OfferingStatus;
}

export interface AdminProgramSummaryDto {
  id: string;
  code: string;
  name: string;
  status: ProgramStatus;
  offering: ProgramOfferingRef;
  /** Snapshot taken at creation (frozen after publication). Format amounts with these. */
  rewardUnit: RewardUnit;
  currencyCode: string;
  currencyMinorUnits: number;
  timezone: string;
  startsAt: string;
  endsAt: string | null;
  enrollmentOpensAt: string;
  enrollmentClosesAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  activeOptionCount: number;
  activeEnrollmentCount: number;
  pendingEnrollmentCount: number;
}

export interface ProgramOptionDto {
  id: string;
  programId: string;
  name: string;
  description: string | null;
  /** Minor units of `currencyCode` (decimal string). */
  priceMinor: string;
  currencyCode: string;
  billingFrequency: BillingFrequency;
  durationDays: number;
  renewalPolicy: RenewalPolicy;
  isActive: boolean;
  sortOrder: number;
  enrollmentCount: number;
  /** True once the option has enrollments: price, duration and frequency are then frozen. */
  termsLocked: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProgramStatusChangeDto {
  id: string;
  fromStatus: ProgramStatus | null;
  toStatus: ProgramStatus;
  changedAt: string;
  /** Null for automatic (scheduler) transitions. */
  changedBy: CatalogUserRef | null;
  reason: string | null;
}

export interface ProgramPolicyVersionRef {
  id: string;
  version: number;
  name: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface ProgramPolicySummary {
  draftCount: number;
  publishedCount: number;
  retiredCount: number;
  /** The published version in effect now. */
  current: ProgramPolicyVersionRef | null;
  /** The next published version that starts in the future. */
  upcoming: ProgramPolicyVersionRef | null;
}

export const ProgramPublishCheckKey = ['ACTIVE_OPTION', 'OFFERING_ACTIVE', 'DATES_VALID', 'PUBLISHED_POLICY'] as const;
export type ProgramPublishCheckKey = (typeof ProgramPublishCheckKey)[number];

export interface ProgramPublishCheck {
  key: ProgramPublishCheckKey;
  ok: boolean;
  message: string;
}

export interface AdminProgramDetailDto extends AdminProgramSummaryDto {
  description: string | null;
  maxRewardDepth: number;
  lateEventGraceDays: number;
  eligibility: ProgramEligibility;
  termsVersion: string;
  termsText: string | null;
  createdBy: CatalogUserRef | null;
  updatedBy: CatalogUserRef | null;
  options: ProgramOptionDto[];
  policySummary: ProgramPolicySummary;
  enrollmentCounts: Record<EnrollmentStatus, number>;
  /** Newest first (at most 100). */
  statusHistory: ProgramStatusChangeDto[];
  adminCount: number;
  /** Publish preconditions (all must pass to publish a DRAFT). */
  publishChecks: ProgramPublishCheck[];
  /** Fields the PATCH endpoint accepts in the current status. */
  editableFields: ProgramEditableField[];
  /** Lifecycle actions valid in the current status (permissions are checked separately). */
  allowedActions: ProgramLifecycleAction[];
  /** Only DRAFT programs without published policy versions can be deleted. */
  canDelete: boolean;
}

export interface ProgramAdminDto {
  userId: string;
  fullName: string;
  email: string;
  assignedAt: string;
}

export interface ProgramAdminCandidateDto {
  userId: string;
  fullName: string;
  email: string;
}

// ─── Member catalogue ───────────────────────────────────────────────────────

export interface MemberProgramOptionDto {
  id: string;
  name: string;
  description: string | null;
  /** Price of the plan (product/service access) in minor units of `currencyCode`. Earns nothing. */
  priceMinor: string;
  currencyCode: string;
  billingFrequency: BillingFrequency;
  durationDays: number;
  renewalPolicy: RenewalPolicy;
}

export interface MemberProgramEnrollmentRef {
  id: string;
  status: EnrollmentStatus;
  optionName: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

export interface MemberProgramDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: ProgramStatus;
  offering: { name: string; kind: OfferingKind; description: string | null };
  currencyCode: string;
  currencyMinorUnits: number;
  timezone: string;
  startsAt: string;
  endsAt: string | null;
  enrollmentOpensAt: string;
  enrollmentClosesAt: string | null;
  /** The program is ACTIVE and its enrollment window is open right now. */
  enrollmentOpen: boolean;
  eligibility: ProgramEligibility;
  /** Whether the signed-in member meets the program's eligibility rules (and why not). */
  myEligibility: { eligible: boolean; reasons: string[] };
  termsVersion: string;
  options: MemberProgramOptionDto[];
  /** The member's current (PENDING or ACTIVE) enrollments in this program, oldest first. */
  myEnrollments: MemberProgramEnrollmentRef[];
}

export interface MemberProgramDetailDto extends MemberProgramDto {
  termsText: string | null;
}
