// Contracts (Zod request schemas + response types) for the enrollments module
// (docs/business-rules.md §5). Option prices pay for the plan (product/service access); an
// enrollment or its payment never triggers a reward.
import { z } from 'zod';
import { cursorPageQuerySchema, minorAmountSchema, reasonSchema } from '../api';
import { BillingFrequency, EligibilityStatus, EnrollmentStatus, ProgramStatus, RenewalPolicy } from '../enums';
import type { CatalogUserRef } from './settings';

// ─── Requests ───────────────────────────────────────────────────────────────

/** `POST /programs/:id/enrollments` — free options activate immediately, paid ones wait for payment. */
export const createEnrollmentSchema = z.object({
  optionId: z.uuid('Choose a plan'),
  acceptTerms: z.literal(true, { error: 'Please accept the program terms to continue' }),
  /** The terms version the member accepted; a mismatch with the current terms → 409. */
  termsVersion: z.string().trim().min(1).max(32).optional(),
});
export type CreateEnrollmentInput = z.infer<typeof createEnrollmentSchema>;

/** `POST /users/me/enrollments/:id/cancel` (optional note). */
export const cancelMyEnrollmentSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});
export type CancelMyEnrollmentInput = z.infer<typeof cancelMyEnrollmentSchema>;

/**
 * `POST /admin/enrollments/:id/activate` — records the offline payment of a paid plan. The
 * reference must be unique and is never reusable as a sale id.
 */
export const activateEnrollmentSchema = z.object({
  paymentReference: z
    .string()
    .trim()
    .min(3, 'Enter the payment reference (at least 3 characters)')
    .max(128)
    .regex(/^[\x21-\x7E]+(?: [\x21-\x7E]+)*$/, 'Use printable characters only'),
  /** Amount received, in minor units of the program currency. */
  paymentAmountMinor: minorAmountSchema,
});
export type ActivateEnrollmentInput = z.infer<typeof activateEnrollmentSchema>;

/** `POST /admin/enrollments/:id/reject` and `/cancel`. */
export const enrollmentDecisionSchema = z.object({ reason: reasonSchema });
export type EnrollmentDecisionInput = z.infer<typeof enrollmentDecisionSchema>;

const enrollmentStatusFilter = z.union([
  z.enum(EnrollmentStatus),
  z.array(z.enum(EnrollmentStatus)).max(EnrollmentStatus.length),
]);

/** `GET /admin/enrollments` — newest first; PROGRAM_ADMINs only see their programs. */
export const listAdminEnrollmentsQuerySchema = cursorPageQuerySchema.extend({
  status: enrollmentStatusFilter.optional(),
  programId: z.uuid().optional(),
  userId: z.uuid().optional(),
  /** Case-insensitive match on member name, email or payment reference. */
  q: z.string().trim().max(100).optional(),
});
export type ListAdminEnrollmentsQuery = z.infer<typeof listAdminEnrollmentsQuerySchema>;

/** `GET /users/me/enrollments` — newest first. */
export const listMyEnrollmentsQuerySchema = cursorPageQuerySchema.extend({
  status: enrollmentStatusFilter.optional(),
  programId: z.uuid().optional(),
});
export type ListMyEnrollmentsQuery = z.infer<typeof listMyEnrollmentsQuerySchema>;

// ─── Responses ──────────────────────────────────────────────────────────────

/** Immutable copy of the option at enrollment time. */
export interface EnrollmentOptionSnapshotDto {
  optionId: string;
  name: string;
  /** Minor units of `currencyCode` (decimal string). */
  priceMinor: string;
  currencyCode: string;
  billingFrequency: BillingFrequency;
  durationDays: number;
  renewalPolicy: RenewalPolicy;
}

export interface EnrollmentProgramRef {
  id: string;
  code: string;
  name: string;
  status: ProgramStatus;
  timezone: string;
  currencyCode: string;
  currencyMinorUnits: number;
}

export interface MyEnrollmentDto {
  id: string;
  status: EnrollmentStatus;
  eligibilityStatus: EligibilityStatus;
  program: EnrollmentProgramRef;
  option: EnrollmentOptionSnapshotDto;
  termsVersion: string;
  /** Coverage period [effectiveFrom, effectiveTo); null until activated. */
  effectiveFrom: string | null;
  effectiveTo: string | null;
  /** Activated coverage that has not started yet (a renewal queued after the current period). */
  upcoming: boolean;
  cancelledAt: string | null;
  /** Rejection / cancellation note. */
  statusReason: string | null;
  paymentRecordedAt: string | null;
  createdAt: string;
  /** PENDING, or ACTIVE coverage that has not ended yet. */
  canCancel: boolean;
}

export interface AdminEnrollmentDto extends Omit<MyEnrollmentDto, 'canCancel'> {
  member: { id: string; fullName: string; email: string };
  /** Sponsor snapshot at enrollment time. */
  sponsor: CatalogUserRef | null;
  paymentReference: string | null;
  /** Minor units of the program currency (decimal string). */
  paymentAmountMinor: string | null;
  paymentRecordedBy: CatalogUserRef | null;
  updatedAt: string;
  /** Actions valid in the current status (permissions/scope are checked by the API). */
  allowedActions: Array<'activate' | 'reject' | 'cancel'>;
}
