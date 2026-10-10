// Contracts (Zod request schemas + response types) for the policies module.
// Business rules §7 (reward policies) and §8 (dry-run). Amounts are minor-unit decimal strings:
// - sale amounts (`saleAmountMinor`, `minEventAmountMinor`) are in the program CURRENCY;
// - reward amounts (`fixedAmountMinor`, `capMinor`, `maxTotalPerEventMinor`, allocations) are in the
//   program REWARD UNIT (currency minor units for MONEY, whole points for POINTS).
import { z } from 'zod';
import {
  IneligibleAncestorBehavior,
  PolicyStatus,
  ProgramStatus,
  QualifyingEventType,
  RewardCalcType,
  RewardUnit,
  RoundingMode,
} from '../enums';
import {
  cursorPageQuerySchema,
  isoDateTimeSchema,
  minorAmountSchema,
  positiveMinorAmountSchema,
  reasonSchema,
  uuidSchema,
} from '../api';

/** Hard ceiling on total rewards per sale: 50% of the sale value (business rules §0.2, DB CHECK). */
export const POLICY_HARD_CAP_BPS = 5000;
/** Absolute ceiling on reward depth (a program may set a lower `maxRewardDepth`). */
export const POLICY_MAX_DEPTH = 10;
export const POLICY_MAX_POINTS_RATE = 1_000_000;
/** Longest synthetic ancestor chain accepted by the dry-run. */
export const DRY_RUN_MAX_ANCESTORS = 50;

/**
 * Where a version sits on the program timeline (derived, relative to now):
 * DRAFT; SCHEDULED (published, starts later); CURRENT (in effect now); ENDED (published, closed by a
 * successor); RETIRED (retired after taking effect); WITHDRAWN (retired before taking effect — empty range).
 */
export const PolicyPhase = ['DRAFT', 'SCHEDULED', 'CURRENT', 'ENDED', 'RETIRED', 'WITHDRAWN'] as const;
export type PolicyPhase = (typeof PolicyPhase)[number];

/** Per-level decision recorded by the calculator (trace + dry-run). */
export const CalcLevelDecision = [
  'AWARDED',
  'NO_RULE',
  'NO_ANCESTOR',
  'INELIGIBLE_FORFEITED',
  'BUDGET_EXHAUSTED',
  'ZERO_AMOUNT',
] as const;
export type CalcLevelDecision = (typeof CalcLevelDecision)[number];

// ─── Requests ────────────────────────────────────────────────────────────────

/**
 * One reward level. FIXED needs `fixedAmountMinor`, PERCENTAGE needs `percentageBps`; the field that
 * does not apply to the chosen type is ignored (normalized to null).
 */
export const policyRuleInputSchema = z
  .object({
    level: z.number().int().min(1, 'Levels start at 1').max(POLICY_MAX_DEPTH, `Levels go up to ${POLICY_MAX_DEPTH}`),
    calcType: z.enum(RewardCalcType),
    fixedAmountMinor: positiveMinorAmountSchema.nullable().optional(),
    percentageBps: z
      .number()
      .int('Use at most two decimals')
      .min(1, 'Must be at least 0.01%')
      .max(POLICY_HARD_CAP_BPS, 'A level can never exceed 50% of the sale')
      .nullable()
      .optional(),
    capMinor: positiveMinorAmountSchema.nullable().optional(),
  })
  .superRefine((rule, ctx) => {
    if (rule.calcType === 'FIXED' && (rule.fixedAmountMinor === null || rule.fixedAmountMinor === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['fixedAmountMinor'], message: 'Enter the fixed reward amount' });
    }
    if (rule.calcType === 'PERCENTAGE' && (rule.percentageBps === null || rule.percentageBps === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['percentageBps'], message: 'Enter the percentage of the sale' });
    }
  })
  .transform((rule) => ({
    level: rule.level,
    calcType: rule.calcType,
    fixedAmountMinor: rule.calcType === 'FIXED' ? (rule.fixedAmountMinor ?? null) : null,
    percentageBps: rule.calcType === 'PERCENTAGE' ? (rule.percentageBps ?? null) : null,
    capMinor: rule.capMinor ?? null,
  }));
export type PolicyRuleInput = z.input<typeof policyRuleInputSchema>;
export type PolicyRule = z.output<typeof policyRuleInputSchema>;

export const policyRulesSchema = z
  .array(policyRuleInputSchema)
  .max(POLICY_MAX_DEPTH, `At most ${POLICY_MAX_DEPTH} levels`)
  .superRefine((rules, ctx) => {
    const seen = new Set<number>();
    rules.forEach((rule, i) => {
      if (seen.has(rule.level)) {
        ctx.addIssue({ code: 'custom', path: [i, 'level'], message: `Level ${rule.level} is defined more than once` });
      }
      seen.add(rule.level);
    });
  });

export const policyTriggerTypesSchema = z
  .array(z.enum(QualifyingEventType))
  .min(1, 'Select at least one qualifying sale type')
  .refine((types) => new Set(types).size === types.length, 'Each sale type can be selected once');

/** Every editable field of a policy version (DRAFT only). */
export const policyFieldsSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(160),
  notes: z.string().trim().max(2000).nullable(),
  triggerEventTypes: policyTriggerTypesSchema,
  maxDepth: z.number().int().min(1, 'At least one level').max(POLICY_MAX_DEPTH),
  budgetBps: z
    .number()
    .int('Use at most two decimals')
    .min(1, 'Budget must be at least 0.01%')
    .max(POLICY_HARD_CAP_BPS, 'Total rewards can never exceed 50% of the sale'),
  /** Optional absolute cap on total rewards per sale (reward-unit minor units). */
  maxTotalPerEventMinor: positiveMinorAmountSchema.nullable(),
  /** Smallest sale (currency minor units) that earns rewards. */
  minEventAmountMinor: minorAmountSchema,
  /** POINTS programs: points per one major currency unit of sale value. */
  pointsPerCurrencyUnit: z.number().int().min(1).max(POLICY_MAX_POINTS_RATE),
  ineligibleAncestorBehavior: z.enum(IneligibleAncestorBehavior),
  roundingMode: z.enum(RoundingMode),
  /** false = rewards from API/WEBHOOK sales auto-approve (publish needs `policies:auto-approve`). */
  requiresApproval: z.boolean(),
  requireActiveEnrollment: z.boolean(),
  rules: policyRulesSchema,
});
export type PolicyFieldsInput = z.input<typeof policyFieldsSchema>;
export type PolicyFields = z.output<typeof policyFieldsSchema>;

/** Partial field set (PATCH body, unsaved edits sent to validate / dry-run). */
export const policyChangesSchema = policyFieldsSchema.partial();
export type PolicyChangesInput = z.input<typeof policyChangesSchema>;

/**
 * POST /admin/programs/:id/policies — new DRAFT. Omitted fields come from `cloneFromVersionId`
 * (any version of the same program, rules included) or the platform defaults (budget, points rate).
 */
export const createPolicyDraftSchema = policyChangesSchema.extend({
  cloneFromVersionId: uuidSchema.optional(),
});
export type CreatePolicyDraftInput = z.input<typeof createPolicyDraftSchema>;

/** PATCH /admin/policies/:id — DRAFT only. `rules`, when present, replaces all rules atomically. */
export const updatePolicyDraftSchema = policyChangesSchema.extend({
  /** Optimistic concurrency: the draft's `updatedAt` as last read (409 STALE_VERSION if it moved). */
  expectedUpdatedAt: isoDateTimeSchema.optional(),
});
export type UpdatePolicyDraftInput = z.input<typeof updatePolicyDraftSchema>;

/** POST /admin/policies/:id/validate — validates the stored draft merged with optional unsaved changes. */
export const validatePolicySchema = z.object({
  /** Adds publish-time checks for this start (no retroactive policies, overlaps, bound sales). */
  effectiveFrom: isoDateTimeSchema.optional(),
  changes: policyChangesSchema.optional(),
});
export type ValidatePolicyInput = z.input<typeof validatePolicySchema>;

export const publishPolicySchema = z.object({
  /** Must not be in the past (1 minute clock skew allowed). */
  effectiveFrom: isoDateTimeSchema,
});
export type PublishPolicyInput = z.input<typeof publishPolicySchema>;

export const retirePolicySchema = z.object({ reason: reasonSchema });
export type RetirePolicyInput = z.input<typeof retirePolicySchema>;

/**
 * POST /admin/policies/:id/dry-run — read-only preview with the real calculator. Either a synthetic
 * chain (`ancestors[i]` = the ancestor at depth i + 1) or a real member's tree + eligibility at
 * `occurredAt` (default now). `changes` previews unsaved edits of a DRAFT.
 */
export const dryRunPolicySchema = z
  .object({
    eventType: z.enum(QualifyingEventType),
    saleAmountMinor: positiveMinorAmountSchema,
    ancestors: z
      .array(z.object({ eligible: z.boolean() }))
      .max(DRY_RUN_MAX_ANCESTORS, `At most ${DRY_RUN_MAX_ANCESTORS} ancestors`)
      .optional(),
    subjectUserId: uuidSchema.optional(),
    occurredAt: isoDateTimeSchema.optional(),
    changes: policyChangesSchema.optional(),
  })
  .refine((v) => (v.ancestors === undefined) !== (v.subjectUserId === undefined), {
    message: 'Provide either a synthetic ancestor chain or a member to preview',
    path: ['ancestors'],
  });
export type DryRunPolicyInput = z.input<typeof dryRunPolicySchema>;

export const listPoliciesQuerySchema = cursorPageQuerySchema.extend({
  status: z.enum(PolicyStatus).optional(),
});
export type ListPoliciesQuery = z.input<typeof listPoliciesQuerySchema>;

// ─── Responses ───────────────────────────────────────────────────────────────

export interface PolicyUserRefDto {
  id: string;
  fullName: string;
}

export interface PolicyRuleDto {
  id: string;
  level: number;
  calcType: RewardCalcType;
  fixedAmountMinor: string | null;
  percentageBps: number | null;
  capMinor: string | null;
}

export interface PolicyProgramContextDto {
  id: string;
  code: string;
  name: string;
  status: ProgramStatus;
  rewardUnit: RewardUnit;
  currencyCode: string;
  currencyMinorUnits: number;
  maxRewardDepth: number;
  timezone: string;
}

export interface PolicyVersionSummaryDto {
  id: string;
  programId: string;
  version: number;
  status: PolicyStatus;
  phase: PolicyPhase;
  name: string;
  notes: string | null;
  triggerEventTypes: QualifyingEventType[];
  maxDepth: number;
  budgetBps: number;
  maxTotalPerEventMinor: string | null;
  minEventAmountMinor: string;
  pointsPerCurrencyUnit: number;
  ineligibleAncestorBehavior: IneligibleAncestorBehavior;
  roundingMode: RoundingMode;
  requiresApproval: boolean;
  requireActiveEnrollment: boolean;
  /** null while DRAFT (set on publish). */
  effectiveFrom: string | null;
  /** null = open-ended. */
  effectiveTo: string | null;
  publishedAt: string | null;
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: PolicyUserRefDto | null;
  publishedBy: PolicyUserRefDto | null;
  ruleCount: number;
  /** Σ percentage levels in bps (fixed levels excluded). */
  percentageTotalBps: number;
}

export interface PolicyVersionDto extends PolicyVersionSummaryDto {
  rules: PolicyRuleDto[];
  program: PolicyProgramContextDto;
  /** Sales already priced by this version (a published range can't be closed before them). */
  boundEventCount: number;
}

/** GET /admin/programs/:id/policy-context — what the policies page needs besides the versions. */
export interface PolicyContextDto {
  program: PolicyProgramContextDto;
  /** Defaults for new drafts (platform settings). */
  defaults: { budgetBps: number; pointsPerCurrencyUnit: number };
  hardCapBps: number;
  pointsLabel: string;
  /** Version in effect now / the next scheduled one. */
  currentVersionId: string | null;
  nextScheduledVersionId: string | null;
}

export interface PolicyIssueDto {
  severity: 'error' | 'warning';
  /** Field path (`budgetBps`, `rules.0.percentageBps`, `effectiveFrom`, `program`, …). */
  path: string;
  message: string;
  /** Stable machine code, e.g. `FIXED_BREAK_EVEN`, `PERCENTAGE_OVER_BUDGET`. */
  code?: string;
}

export interface PolicyValidationResultDto {
  valid: boolean;
  issues: PolicyIssueDto[];
}

export interface PublishPolicyResultDto {
  policy: PolicyVersionDto;
  /** The version that was in effect at `effectiveFrom` and was closed there. */
  closedVersion: { id: string; version: number; effectiveTo: string } | null;
}

export interface RetirePolicyResultDto {
  policy: PolicyVersionDto;
  /** true when the version had not started yet (empty range). */
  withdrawn: boolean;
  warnings: string[];
}

export interface DeletedPolicyDto {
  id: string;
  deleted: true;
}

/** One step of a calculation trace (stored with every calculation; admin-only). */
export type CalcTraceStepDto =
  | { step: 'base'; saleAmountMinor: string; rewardUnit: RewardUnit; baseMinor: string; note: string }
  | { step: 'budget'; budgetBps: number; budgetMinor: string; maxTotalPerEventMinor: string | null }
  | { step: 'level'; level: number; decision: CalcLevelDecision; detail: Record<string, unknown> };

export interface DryRunAncestorDto {
  depth: number;
  eligible: boolean;
  reason: string | null;
  /** MEMBER mode only. Display name = first name + last initial. */
  userId: string | null;
  displayName: string | null;
}

export interface DryRunLevelDto {
  level: number;
  decision: CalcLevelDecision;
  depth: number | null;
  userId: string | null;
  displayName: string | null;
  calcType: RewardCalcType | null;
  percentageBps: number | null;
  fixedAmountMinor: string | null;
  capMinor: string | null;
  ruleAmountMinor: string | null;
  amountMinor: string | null;
  capped: boolean;
  budgetLimited: boolean;
  reason: string | null;
}

export interface DryRunAllocationDto {
  level: number;
  depth: number;
  userId: string | null;
  displayName: string | null;
  ruleAmountMinor: string;
  amountMinor: string;
  capped: boolean;
  budgetLimited: boolean;
}

export interface DryRunResultDto {
  policyVersionId: string;
  mode: 'SYNTHETIC' | 'MEMBER';
  eventType: QualifyingEventType;
  saleAmountMinor: string;
  /** MEMBER mode: the instant eligibility was judged at. */
  occurredAt: string | null;
  unit: { rewardUnit: RewardUnit; currencyCode: string; currencyMinorUnits: number; pointsPerCurrencyUnit: number };
  /** false when the engine would reject the sale under this policy (type not listed, below minimum). */
  applicable: boolean;
  notApplicableReason: string | null;
  baseMinor: string;
  budgetBps: number;
  budgetMinor: string;
  /** 50% of the base: the absolute ceiling no policy can exceed. */
  hardCapMinor: string;
  totalAllocatedMinor: string;
  unallocatedMinor: string;
  allocations: DryRunAllocationDto[];
  levels: DryRunLevelDto[];
  ancestors: DryRunAncestorDto[];
  warnings: string[];
  engineVersion: string;
  trace: CalcTraceStepDto[];
}

/** GET /programs/:id/policy — member transparency (no internal fields). */
export interface MemberPolicyLevelDto {
  level: number;
  calcType: RewardCalcType;
  percentageBps: number | null;
  fixedAmountMinor: string | null;
  capMinor: string | null;
}

export interface MemberProgramPolicyDto {
  programId: string;
  version: number;
  rewardUnit: RewardUnit;
  currencyCode: string;
  currencyMinorUnits: number;
  triggerEventTypes: QualifyingEventType[];
  budgetBps: number;
  hardCapBps: number;
  maxDepth: number;
  maxTotalPerEventMinor: string | null;
  minEventAmountMinor: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** false = the next scheduled version (nothing is in effect yet). */
  inEffect: boolean;
  levels: MemberPolicyLevelDto[];
}
