import type { EnrollmentStatus, ProgramEligibility } from '@app/shared';
import { programEligibilitySchema } from '@app/shared';

/** Pure enrollment rules (business rules §5). */

export const DAY_MS = 86_400_000;

/** Parses the stored `programs.eligibility` JSON; unknown/invalid content means "no extra rules". */
export function parseEligibility(value: unknown): ProgramEligibility {
  const parsed = programEligibilitySchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

export interface EligibilityMember {
  createdAt: Date;
  hasSponsor: boolean;
}

/** Program eligibility rules (`minAccountAgeDays`, `requireSponsor`) for one member at `now`. */
export function evaluateEligibility(
  rules: ProgramEligibility,
  member: EligibilityMember,
  now: Date,
): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (rules.minAccountAgeDays !== undefined && rules.minAccountAgeDays > 0) {
    const ageMs = now.getTime() - member.createdAt.getTime();
    if (ageMs < rules.minAccountAgeDays * DAY_MS) {
      reasons.push(`Your account must be at least ${rules.minAccountAgeDays} day(s) old to join this program`);
    }
  }
  if (rules.requireSponsor && !member.hasSponsor) {
    reasons.push('This program is only open to members who joined through a referral');
  }
  return { eligible: reasons.length === 0, reasons };
}

/**
 * Coverage of a newly activated enrollment: starts at `max(now, end of the member's current
 * period)` so a renewal follows the current period without a gap or overlap, and lasts
 * `durationDays`.
 */
export function computeCoverage(
  now: Date,
  currentPeriodEnd: Date | null,
  durationDays: number,
): { effectiveFrom: Date; effectiveTo: Date } {
  const start = currentPeriodEnd && currentPeriodEnd.getTime() > now.getTime() ? currentPeriodEnd : now;
  return { effectiveFrom: new Date(start.getTime()), effectiveTo: new Date(start.getTime() + durationDays * DAY_MS) };
}

export interface CancellableEnrollment {
  status: EnrollmentStatus;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
}

export type CancellationDecision =
  | { ok: true; effectiveTo: Date | null }
  | { ok: false; reason: 'TERMINAL' | 'ENDED' };

/**
 * Cancellation (member or admin): PENDING → CANCELLED; ACTIVE → CANCELLED with `effectiveTo`
 * shortened to `max(now, effectiveFrom)` (an unstarted renewal becomes an empty period). Coverage
 * that already ended cannot be cancelled (it is about to expire). `effectiveTo` in the result is the
 * value to store (unchanged when null).
 */
export function decideCancellation(e: CancellableEnrollment, now: Date): CancellationDecision {
  if (e.status === 'PENDING') return { ok: true, effectiveTo: e.effectiveTo };
  if (e.status !== 'ACTIVE') return { ok: false, reason: 'TERMINAL' };
  if (!e.effectiveFrom || !e.effectiveTo) return { ok: true, effectiveTo: e.effectiveTo };
  if (e.effectiveTo.getTime() <= now.getTime()) return { ok: false, reason: 'ENDED' };
  const cut = new Date(Math.max(now.getTime(), e.effectiveFrom.getTime()));
  return { ok: true, effectiveTo: cut.getTime() < e.effectiveTo.getTime() ? cut : e.effectiveTo };
}

/** Whether the member (or an admin) may cancel the enrollment now. */
export function canCancel(e: CancellableEnrollment, now: Date): boolean {
  return decideCancellation(e, now).ok;
}

/** Admin actions valid in the current status. */
export function adminEnrollmentActions(e: CancellableEnrollment, now: Date): Array<'activate' | 'reject' | 'cancel'> {
  const actions: Array<'activate' | 'reject' | 'cancel'> = [];
  if (e.status === 'PENDING') actions.push('activate', 'reject');
  if (canCancel(e, now)) actions.push('cancel');
  return actions;
}
