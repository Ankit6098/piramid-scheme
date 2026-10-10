import { describe, expect, it } from 'vitest';
import {
  createProgramOptionSchema,
  createProgramSchema,
  optionDurationIssue,
  programDateIssues,
  programEditableFields,
  programLifecycleActions,
} from '@app/shared';
import {
  canCancelScheduled,
  computeCancellationEndsAt,
  computeCompletionDates,
  evaluatePublishChecks,
  isEnrollmentWindowOpen,
  publishTargetStatus,
  validateProgramPatch,
  type ProgramPatchCurrent,
} from './program-rules';

const DAY = 86_400_000;
const now = new Date('2026-10-10T12:00:00.000Z');
const at = (days: number) => new Date(now.getTime() + days * DAY);

describe('optionDurationIssue (duration vs billing frequency)', () => {
  it.each([
    ['MONTHLY', 28],
    ['MONTHLY', 31],
    ['QUARTERLY', 89],
    ['QUARTERLY', 92],
    ['HALF_YEARLY', 181],
    ['HALF_YEARLY', 184],
    ['YEARLY', 365],
    ['YEARLY', 366],
    ['ONE_TIME', 1],
    ['ONE_TIME', 3660],
  ] as const)('accepts %s with %i days', (frequency, days) => {
    expect(optionDurationIssue(frequency, days)).toBeNull();
  });

  it.each([
    ['MONTHLY', 27],
    ['MONTHLY', 32],
    ['QUARTERLY', 88],
    ['QUARTERLY', 93],
    ['HALF_YEARLY', 180],
    ['HALF_YEARLY', 185],
    ['YEARLY', 364],
    ['YEARLY', 367],
    ['ONE_TIME', 0],
    ['ONE_TIME', 3661],
  ] as const)('rejects %s with %i days', (frequency, days) => {
    expect(optionDurationIssue(frequency, days)).toMatch(/days/);
  });

  it('rejects fractional durations', () => {
    expect(optionDurationIssue('ONE_TIME', 1.5)).toMatch(/whole/);
  });

  it('is applied by the create-option schema', () => {
    const bad = createProgramOptionSchema.safeParse({ name: 'Monthly', priceMinor: '1000', billingFrequency: 'MONTHLY', durationDays: 90 });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path).toEqual(['durationDays']);
    const ok = createProgramOptionSchema.parse({ name: 'Monthly', priceMinor: '1000', billingFrequency: 'MONTHLY', durationDays: 30 });
    expect(ok.renewalPolicy).toBe('MANUAL');
  });
});

describe('programDateIssues', () => {
  it('accepts consistent dates and open-ended programs', () => {
    expect(programDateIssues({ startsAt: at(1), endsAt: at(30), enrollmentOpensAt: at(1), enrollmentClosesAt: at(20) })).toEqual([]);
    expect(programDateIssues({ startsAt: at(1), endsAt: null, enrollmentOpensAt: at(0), enrollmentClosesAt: null })).toEqual([]);
  });

  it('flags every DB date CHECK', () => {
    const paths = programDateIssues({ startsAt: at(10), endsAt: at(5), enrollmentOpensAt: at(6), enrollmentClosesAt: at(6) }).map(
      (i) => i.path,
    );
    expect(paths).toContain('endsAt');
    expect(paths).toContain('enrollmentClosesAt');
    expect(paths).toContain('enrollmentOpensAt');
  });

  it('requires enrollment to close by the end', () => {
    const issues = programDateIssues({ startsAt: at(0), endsAt: at(10), enrollmentOpensAt: at(0), enrollmentClosesAt: at(11) });
    expect(issues).toEqual([{ path: 'enrollmentClosesAt', message: 'Enrollment must close by the program end' }]);
  });

  it('is applied by the create-program schema (enrollment opening defaults to the start)', () => {
    const base = {
      code: 'spring-2027',
      name: 'Spring',
      offeringId: '6f1e3c3a-5b52-4a8d-9e0e-0c5f0f5f6e11',
      startsAt: at(10).toISOString(),
    };
    expect(createProgramSchema.safeParse({ ...base, endsAt: at(5).toISOString() }).success).toBe(false);
    const parsed = createProgramSchema.parse({ ...base, endsAt: at(40).toISOString() });
    expect(parsed.timezone).toBe('Asia/Kolkata');
    expect(parsed.maxRewardDepth).toBe(5);
    expect(createProgramSchema.safeParse({ ...base, code: 'Bad Code' }).success).toBe(false);
    expect(createProgramSchema.safeParse({ ...base, timezone: 'Mars/Olympus' }).success).toBe(false);
  });
});

describe('status rules', () => {
  it('lists editable fields per status', () => {
    expect(programEditableFields('DRAFT')).toContain('code');
    expect(programEditableFields('SCHEDULED')).toEqual(expect.arrayContaining(['startsAt', 'enrollmentOpensAt', 'endsAt']));
    expect(programEditableFields('ACTIVE')).not.toContain('startsAt');
    expect(programEditableFields('ACTIVE')).not.toContain('offeringId');
    expect(programEditableFields('ACTIVE')).not.toContain('maxRewardDepth');
    expect(programEditableFields('COMPLETED')).not.toContain('endsAt');
    expect(programEditableFields('ARCHIVED')).toEqual([]);
  });

  it('lists manual lifecycle actions per status (DB state machine)', () => {
    expect(programLifecycleActions('DRAFT')).toEqual(['publish']);
    expect(programLifecycleActions('SCHEDULED')).toEqual(['cancel']);
    expect(programLifecycleActions('ACTIVE')).toEqual(['pause', 'complete']);
    expect(programLifecycleActions('PAUSED')).toEqual(['resume', 'complete']);
    expect(programLifecycleActions('COMPLETED')).toEqual(['archive']);
    expect(programLifecycleActions('ARCHIVED')).toEqual([]);
  });

  it('publishes to SCHEDULED for a future start and ACTIVE otherwise', () => {
    expect(publishTargetStatus(at(1), now)).toBe('SCHEDULED');
    expect(publishTargetStatus(now, now)).toBe('ACTIVE');
    expect(publishTargetStatus(at(-1), now)).toBe('ACTIVE');
  });
});

describe('evaluatePublishChecks', () => {
  const ready = {
    startsAt: at(-1),
    endsAt: at(30),
    enrollmentOpensAt: at(-1),
    enrollmentClosesAt: null,
    activeOptionCount: 1,
    offeringStatus: 'ACTIVE' as const,
    publishedPolicyCount: 1,
  };

  it('passes when every precondition holds', () => {
    expect(evaluatePublishChecks(ready, now).every((c) => c.ok)).toBe(true);
  });

  it('reports each failing precondition', () => {
    const failing = evaluatePublishChecks(
      { ...ready, activeOptionCount: 0, offeringStatus: 'INACTIVE', publishedPolicyCount: 0, endsAt: at(-0.5) },
      now,
    )
      .filter((c) => !c.ok)
      .map((c) => c.key);
    expect(failing).toEqual(['ACTIVE_OPTION', 'OFFERING_ACTIVE', 'DATES_VALID', 'PUBLISHED_POLICY']);
  });
});

describe('computeCompletionDates', () => {
  it('sets endsAt = now when the end is later or open', () => {
    expect(computeCompletionDates({ startsAt: at(-10), endsAt: at(10), enrollmentOpensAt: at(-10), enrollmentClosesAt: null }, now)).toEqual(
      { endsAt: now },
    );
    expect(computeCompletionDates({ startsAt: at(-10), endsAt: null, enrollmentOpensAt: at(-10), enrollmentClosesAt: null }, now)).toEqual({
      endsAt: now,
    });
  });

  it('keeps a past end and pulls enrollment dates in', () => {
    expect(computeCompletionDates({ startsAt: at(-10), endsAt: at(-1), enrollmentOpensAt: at(-10), enrollmentClosesAt: null }, now)).toEqual(
      {},
    );
    expect(
      computeCompletionDates({ startsAt: at(-10), endsAt: at(10), enrollmentOpensAt: at(-10), enrollmentClosesAt: at(5) }, now),
    ).toEqual({ endsAt: now, enrollmentClosesAt: now });
    const late = computeCompletionDates({ startsAt: at(-10), endsAt: at(10), enrollmentOpensAt: at(2), enrollmentClosesAt: at(5) }, now);
    expect(late.endsAt).toEqual(now);
    expect(late.enrollmentClosesAt).toEqual(now);
    expect(late.enrollmentOpensAt!.getTime()).toBeLessThan(now.getTime());
  });
});

describe('cancelling a scheduled program', () => {
  const SEC = 1_000;

  it('keeps an existing end date', () => {
    expect(computeCancellationEndsAt({ startsAt: at(5), endsAt: at(40), enrollmentOpensAt: at(5), enrollmentClosesAt: at(20) })).toBeNull();
  });

  it('ends one second after the start when no end is set and enrollment fits', () => {
    expect(computeCancellationEndsAt({ startsAt: at(5), endsAt: null, enrollmentOpensAt: at(2), enrollmentClosesAt: null })).toEqual(
      new Date(at(5).getTime() + SEC),
    );
  });

  it('moves the end past the enrollment window so the date CHECKs hold', () => {
    expect(computeCancellationEndsAt({ startsAt: at(5), endsAt: null, enrollmentOpensAt: at(7), enrollmentClosesAt: null })).toEqual(
      new Date(at(7).getTime() + SEC),
    );
    expect(computeCancellationEndsAt({ startsAt: at(5), endsAt: null, enrollmentOpensAt: at(5), enrollmentClosesAt: at(30) })).toEqual(at(30));
  });

  it('is allowed only for SCHEDULED programs whose start is still ahead', () => {
    expect(canCancelScheduled({ status: 'SCHEDULED', startsAt: at(1) }, now)).toBe(true);
    expect(canCancelScheduled({ status: 'SCHEDULED', startsAt: now }, now)).toBe(false);
    expect(canCancelScheduled({ status: 'ACTIVE', startsAt: at(1) }, now)).toBe(false);
  });
});

describe('isEnrollmentWindowOpen', () => {
  it('is open within [opensAt, closesAt)', () => {
    expect(isEnrollmentWindowOpen({ enrollmentOpensAt: at(-1), enrollmentClosesAt: null }, now)).toBe(true);
    expect(isEnrollmentWindowOpen({ enrollmentOpensAt: at(1), enrollmentClosesAt: null }, now)).toBe(false);
    expect(isEnrollmentWindowOpen({ enrollmentOpensAt: at(-2), enrollmentClosesAt: now }, now)).toBe(false);
  });
});

describe('validateProgramPatch', () => {
  const current = (status: ProgramPatchCurrent['status']): ProgramPatchCurrent => ({
    status,
    startsAt: at(-5),
    endsAt: at(30),
    enrollmentOpensAt: at(-5),
    enrollmentClosesAt: null,
    termsVersion: '1.0',
    termsText: 'Terms',
  });

  it('allows any field on a draft', () => {
    expect(validateProgramPatch(current('DRAFT'), { code: 'x-1', maxRewardDepth: 3 }, now)).toEqual({ notEditable: [], issues: [] });
  });

  it('rejects frozen fields after publication', () => {
    expect(validateProgramPatch(current('ACTIVE'), { offeringId: 'x', code: 'y', name: 'ok' }, now).notEditable).toEqual([
      'offeringId',
      'code',
    ]);
    expect(validateProgramPatch(current('ACTIVE'), { startsAt: at(1).toISOString() }, now).notEditable).toEqual(['startsAt']);
    expect(validateProgramPatch(current('COMPLETED'), { endsAt: at(40).toISOString() }, now).notEditable).toEqual(['endsAt']);
    expect(validateProgramPatch(current('ARCHIVED'), { name: 'x' }, now).notEditable).toEqual(['name']);
  });

  it('keeps a published end in the future and requires a new terms version for new terms', () => {
    expect(validateProgramPatch(current('ACTIVE'), { endsAt: at(-1).toISOString() }, now).issues.map((i) => i.path)).toContain('endsAt');
    expect(validateProgramPatch(current('ACTIVE'), { endsAt: null }, now).issues.map((i) => i.path)).toEqual(['endsAt']);
    expect(validateProgramPatch(current('ACTIVE'), { termsText: 'New terms' }, now).issues).toEqual([
      { path: 'termsVersion', message: 'Changed terms need a new terms version' },
    ]);
    expect(validateProgramPatch(current('ACTIVE'), { termsText: 'New terms', termsVersion: '2.0' }, now).issues).toEqual([]);
  });

  it('validates merged dates', () => {
    const r = validateProgramPatch(current('ACTIVE'), { enrollmentClosesAt: at(40).toISOString() }, now);
    expect(r.issues.map((i) => i.path)).toEqual(['enrollmentClosesAt']);
    const scheduled = { ...current('SCHEDULED'), startsAt: at(5), enrollmentOpensAt: at(5) };
    expect(validateProgramPatch(scheduled, { startsAt: at(-1).toISOString() }, now).issues.map((i) => i.path)).toContain('startsAt');
  });
});
