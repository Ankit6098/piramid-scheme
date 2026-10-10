import { describe, expect, it } from 'vitest';
import {
  adminEnrollmentActions,
  canCancel,
  computeCoverage,
  DAY_MS,
  decideCancellation,
  evaluateEligibility,
  parseEligibility,
} from './enrollment-rules';

const now = new Date('2026-10-10T12:00:00.000Z');
const at = (days: number) => new Date(now.getTime() + days * DAY_MS);

describe('parseEligibility', () => {
  it('parses stored rules and ignores invalid content', () => {
    expect(parseEligibility({ minAccountAgeDays: 7, requireSponsor: true })).toEqual({ minAccountAgeDays: 7, requireSponsor: true });
    expect(parseEligibility(null)).toEqual({});
    expect(parseEligibility({ minAccountAgeDays: 'x' })).toEqual({});
  });
});

describe('evaluateEligibility', () => {
  it('passes without rules', () => {
    expect(evaluateEligibility({}, { createdAt: now, hasSponsor: false }, now)).toEqual({ eligible: true, reasons: [] });
  });

  it('enforces minimum account age', () => {
    expect(evaluateEligibility({ minAccountAgeDays: 7 }, { createdAt: at(-6), hasSponsor: true }, now).eligible).toBe(false);
    expect(evaluateEligibility({ minAccountAgeDays: 7 }, { createdAt: at(-7), hasSponsor: true }, now).eligible).toBe(true);
  });

  it('enforces a sponsor requirement and reports every reason', () => {
    const r = evaluateEligibility({ minAccountAgeDays: 30, requireSponsor: true }, { createdAt: now, hasSponsor: false }, now);
    expect(r.eligible).toBe(false);
    expect(r.reasons).toHaveLength(2);
  });
});

describe('computeCoverage', () => {
  it('starts now without a current period', () => {
    expect(computeCoverage(now, null, 30)).toEqual({ effectiveFrom: now, effectiveTo: at(30) });
  });

  it('renews without a gap after the current period', () => {
    expect(computeCoverage(now, at(10), 30)).toEqual({ effectiveFrom: at(10), effectiveTo: at(40) });
  });

  it('ignores a period that already ended', () => {
    expect(computeCoverage(now, at(-1), 30)).toEqual({ effectiveFrom: now, effectiveTo: at(30) });
  });
});

describe('decideCancellation', () => {
  it('cancels pending enrollments without coverage', () => {
    expect(decideCancellation({ status: 'PENDING', effectiveFrom: null, effectiveTo: null }, now)).toEqual({ ok: true, effectiveTo: null });
  });

  it('shortens running coverage to now', () => {
    expect(decideCancellation({ status: 'ACTIVE', effectiveFrom: at(-5), effectiveTo: at(25) }, now)).toEqual({
      ok: true,
      effectiveTo: now,
    });
  });

  it('turns an unstarted renewal into an empty period', () => {
    expect(decideCancellation({ status: 'ACTIVE', effectiveFrom: at(5), effectiveTo: at(35) }, now)).toEqual({
      ok: true,
      effectiveTo: at(5),
    });
  });

  it('refuses ended coverage and terminal states', () => {
    expect(decideCancellation({ status: 'ACTIVE', effectiveFrom: at(-30), effectiveTo: at(-1) }, now)).toEqual({ ok: false, reason: 'ENDED' });
    for (const status of ['CANCELLED', 'EXPIRED', 'REJECTED'] as const) {
      expect(decideCancellation({ status, effectiveFrom: null, effectiveTo: null }, now)).toEqual({ ok: false, reason: 'TERMINAL' });
    }
  });

  it('drives the allowed actions', () => {
    expect(adminEnrollmentActions({ status: 'PENDING', effectiveFrom: null, effectiveTo: null }, now)).toEqual(['activate', 'reject', 'cancel']);
    expect(adminEnrollmentActions({ status: 'ACTIVE', effectiveFrom: at(-1), effectiveTo: at(1) }, now)).toEqual(['cancel']);
    expect(canCancel({ status: 'EXPIRED', effectiveFrom: at(-2), effectiveTo: at(-1) }, now)).toBe(false);
  });
});
