// Contracts (Zod request schemas + response types) for the settings module.
// Platform-wide reward unit (MONEY | POINTS), currency, points label and policy defaults
// (docs/business-rules.md §1).
import { z } from 'zod';
import { currencyCodeSchema, reasonSchema } from '../api';
import { RewardUnit } from '../enums';

/** Minimal reference to the user who performed or owns something (admin views only). */
export interface CatalogUserRef {
  id: string;
  fullName: string;
}

/** Validation limits mirrored from the database CHECK constraints on `platform_settings`. */
export const PLATFORM_SETTINGS_LIMITS = {
  pointsLabelMaxLength: 32,
  pointsPerCurrencyUnitMin: 1,
  pointsPerCurrencyUnitMax: 1_000_000,
  /** 1 bps … 5000 bps (50 %): the hard compliance cap on rewards per sale. */
  defaultRewardBudgetBpsMin: 1,
  defaultRewardBudgetBpsMax: 5000,
} as const;

// ─── Responses ──────────────────────────────────────────────────────────────

/** `GET /settings/public` — everything a client needs to format amounts (no auth required). */
export interface PublicSettingsDto {
  rewardUnit: RewardUnit;
  currencyCode: string;
  currencyMinorUnits: number;
  pointsLabel: string;
}

/** `GET /admin/settings` — the full singleton (SUPER_ADMIN, `settings:write`). */
export interface PlatformSettingsDto extends PublicSettingsDto {
  /** Default points per one major currency unit, copied into new policy drafts. */
  pointsPerCurrencyUnit: number;
  /** Default total reward budget for new policy drafts (basis points of the sale amount, ≤ 5000). */
  defaultRewardBudgetBps: number;
  /** Always false: real-money payouts are not implemented (pinned by a DB CHECK). */
  payoutsEnabled: boolean;
  /** Optimistic-concurrency token; send it back as `expectedVersion`. */
  version: number;
  updatedAt: string;
  updatedBy: CatalogUserRef | null;
  /** Programs that are SCHEDULED, ACTIVE or PAUSED (they keep their own currency snapshot). */
  liveProgramCount: number;
  /**
   * Distinct currencies of live programs. While any live program uses a currency other than the
   * requested one, the platform currency cannot change (DB-enforced).
   */
  liveProgramCurrencyCodes: string[];
}

/** `GET /admin/currencies` — ISO 4217 reference data seeded by migration. */
export interface CurrencyDto {
  code: string;
  name: string;
  minorUnits: number;
}

// ─── Requests ───────────────────────────────────────────────────────────────

/**
 * `PUT /admin/settings`. Only the fields present are changed; `expectedVersion` must match the
 * current version (409 `STALE_VERSION` otherwise) and every change needs an audited reason.
 * Unknown keys (e.g. `payoutsEnabled`) are rejected.
 */
export const updatePlatformSettingsSchema = z
  .strictObject({
    expectedVersion: z.number().int().min(1),
    reason: reasonSchema,
    rewardUnit: z.enum(RewardUnit).optional(),
    currencyCode: currencyCodeSchema.optional(),
    pointsLabel: z
      .string()
      .trim()
      .min(1, 'Enter a label for points')
      .max(PLATFORM_SETTINGS_LIMITS.pointsLabelMaxLength)
      .optional(),
    pointsPerCurrencyUnit: z
      .number()
      .int('Use a whole number')
      .min(PLATFORM_SETTINGS_LIMITS.pointsPerCurrencyUnitMin)
      .max(PLATFORM_SETTINGS_LIMITS.pointsPerCurrencyUnitMax)
      .optional(),
    defaultRewardBudgetBps: z
      .number()
      .int('Use whole basis points')
      .min(PLATFORM_SETTINGS_LIMITS.defaultRewardBudgetBpsMin, 'The budget must be at least 0.01%')
      .max(PLATFORM_SETTINGS_LIMITS.defaultRewardBudgetBpsMax, 'The budget can never exceed 50% of a sale')
      .optional(),
  })
  .refine(
    (v) =>
      v.rewardUnit !== undefined ||
      v.currencyCode !== undefined ||
      v.pointsLabel !== undefined ||
      v.pointsPerCurrencyUnit !== undefined ||
      v.defaultRewardBudgetBps !== undefined,
    { message: 'Change at least one setting' },
  );
export type UpdatePlatformSettingsInput = z.infer<typeof updatePlatformSettingsSchema>;
