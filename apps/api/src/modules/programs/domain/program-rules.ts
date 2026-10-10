import {
  programDateIssues,
  programEditableFields,
  type FieldIssue,
  type OfferingStatus,
  type ProgramEditableField,
  type ProgramPublishCheck,
  type ProgramStatus,
} from '@app/shared';

/**
 * Pure program rules (business rules §4). The DB enforces the state machine and frozen fields; these
 * functions produce friendly, testable decisions before the write.
 */

export interface ProgramDates {
  startsAt: Date;
  endsAt: Date | null;
  enrollmentOpensAt: Date;
  enrollmentClosesAt: Date | null;
}

/** Publishing goes to SCHEDULED when the start is still ahead, otherwise straight to ACTIVE. */
export function publishTargetStatus(startsAt: Date, now: Date): 'SCHEDULED' | 'ACTIVE' {
  return startsAt.getTime() > now.getTime() ? 'SCHEDULED' : 'ACTIVE';
}

export interface PublishCheckInput extends ProgramDates {
  activeOptionCount: number;
  offeringStatus: OfferingStatus;
  publishedPolicyCount: number;
}

/**
 * Publish preconditions: ≥ 1 active option, ACTIVE offering, valid dates (consistent, and the end —
 * if any — still ahead), ≥ 1 PUBLISHED policy version.
 */
export function evaluatePublishChecks(input: PublishCheckInput, now: Date): ProgramPublishCheck[] {
  const dateIssues = programDateIssues(input);
  const endPassed = input.endsAt !== null && input.endsAt.getTime() <= now.getTime();
  const closePassed = input.enrollmentClosesAt !== null && input.enrollmentClosesAt.getTime() <= now.getTime();
  let dateMessage = 'Dates are consistent';
  if (dateIssues.length > 0) dateMessage = dateIssues.map((i) => i.message).join('; ');
  else if (endPassed) dateMessage = 'The program end date has already passed';
  else if (closePassed) dateMessage = 'The enrollment close date has already passed';
  return [
    {
      key: 'ACTIVE_OPTION',
      ok: input.activeOptionCount > 0,
      message: input.activeOptionCount > 0 ? `${input.activeOptionCount} active option(s)` : 'Add at least one active option',
    },
    {
      key: 'OFFERING_ACTIVE',
      ok: input.offeringStatus === 'ACTIVE',
      message: input.offeringStatus === 'ACTIVE' ? 'The offering is approved' : 'The offering must be approved (active) first',
    },
    { key: 'DATES_VALID', ok: dateIssues.length === 0 && !endPassed && !closePassed, message: dateMessage },
    {
      key: 'PUBLISHED_POLICY',
      ok: input.publishedPolicyCount > 0,
      message: input.publishedPolicyCount > 0 ? 'A reward policy is published' : 'Publish at least one reward policy version',
    },
  ];
}

/**
 * Manual completion: `endsAt = now` unless it is already in the past; enrollment dates are pulled in
 * so the DB date CHECKs (`enrollmentOpensAt < endsAt`, `enrollmentClosesAt ≤ endsAt`) still hold.
 * Returns only the fields that change.
 */
export function computeCompletionDates(p: ProgramDates, now: Date): Partial<ProgramDates> {
  const patch: Partial<ProgramDates> = {};
  let endsAt = p.endsAt;
  if (endsAt === null || endsAt.getTime() > now.getTime()) {
    // ends_at must stay strictly after starts_at.
    endsAt = new Date(Math.max(now.getTime(), p.startsAt.getTime() + 1));
    patch.endsAt = endsAt;
  }
  if (p.enrollmentOpensAt.getTime() >= endsAt.getTime()) {
    patch.enrollmentOpensAt = new Date(endsAt.getTime() - 1);
    patch.enrollmentClosesAt = endsAt;
  } else if (p.enrollmentClosesAt !== null && p.enrollmentClosesAt.getTime() > endsAt.getTime()) {
    patch.enrollmentClosesAt = endsAt;
  }
  return patch;
}

/** Program enrollment window is open at `now` (status checked separately). */
export function isEnrollmentWindowOpen(p: Pick<ProgramDates, 'enrollmentOpensAt' | 'enrollmentClosesAt'>, now: Date): boolean {
  if (now.getTime() < p.enrollmentOpensAt.getTime()) return false;
  return p.enrollmentClosesAt === null || now.getTime() < p.enrollmentClosesAt.getTime();
}

export interface ProgramPatchCurrent extends ProgramDates {
  status: ProgramStatus;
  termsVersion: string;
  termsText: string | null;
}

/** A PATCH body with only the editable program fields (undefined = unchanged, null = cleared). */
export type ProgramPatchInput = Partial<Record<ProgramEditableField, unknown>>;

const DATE_FIELDS = ['startsAt', 'endsAt', 'enrollmentOpensAt', 'enrollmentClosesAt'] as const;

/**
 * Validates a program PATCH against the status rules (business rules §4):
 * - only `programEditableFields(status)` may change (others → `notEditable`);
 * - merged dates must be consistent; after publication `endsAt` cannot move into the past or be
 *   removed, and the enrollment close date cannot be set in the past;
 * - a published program's terms text needs a new `termsVersion`.
 * Fields equal to the current value are ignored by the caller before calling this.
 */
export function validateProgramPatch(
  current: ProgramPatchCurrent,
  patch: ProgramPatchInput,
  now: Date,
): { notEditable: ProgramEditableField[]; issues: FieldIssue[] } {
  const editable = new Set(programEditableFields(current.status));
  const changed = (Object.keys(patch) as ProgramEditableField[]).filter((k) => patch[k] !== undefined);
  const notEditable = changed.filter((k) => !editable.has(k));
  const issues: FieldIssue[] = [];
  if (notEditable.length > 0) return { notEditable, issues };

  const merged: ProgramDates = { ...current };
  for (const f of DATE_FIELDS) {
    if (patch[f] === undefined) continue;
    const v = patch[f];
    (merged as unknown as Record<string, Date | null>)[f] = v === null ? null : new Date(v as string);
  }
  issues.push(...programDateIssues(merged));

  const published = current.status !== 'DRAFT';
  if (published) {
    if (patch.endsAt !== undefined) {
      if (merged.endsAt === null) {
        if (current.endsAt !== null) issues.push({ path: 'endsAt', message: 'A published program’s end date cannot be removed' });
      } else if (merged.endsAt.getTime() < now.getTime()) {
        issues.push({ path: 'endsAt', message: 'The end date cannot be moved into the past' });
      }
    }
    if (patch.enrollmentClosesAt !== undefined && merged.enrollmentClosesAt !== null && merged.enrollmentClosesAt.getTime() < now.getTime()) {
      issues.push({ path: 'enrollmentClosesAt', message: 'The enrollment close date cannot be in the past' });
    }
    if (patch.startsAt !== undefined && merged.startsAt.getTime() <= now.getTime()) {
      issues.push({ path: 'startsAt', message: 'A scheduled program’s start must stay in the future' });
    }
    const textChanged = patch.termsText !== undefined && (patch.termsText ?? null) !== current.termsText;
    const versionChanged = patch.termsVersion !== undefined && patch.termsVersion !== current.termsVersion;
    if (textChanged && !versionChanged) {
      issues.push({ path: 'termsVersion', message: 'Changed terms need a new terms version' });
    }
  }
  return { notEditable, issues };
}
