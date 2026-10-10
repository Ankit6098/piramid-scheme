import { describe, expect, it } from 'vitest';
import {
  nextScheduledVersion,
  planPublication,
  planRetirement,
  policyPhase,
  versionInEffect,
  type TimelineVersion,
} from './policy-timeline';

const now = new Date('2026-10-10T12:00:00Z');
const h = (hours: number) => new Date(now.getTime() + hours * 3_600_000);
const v = (version: number, status: TimelineVersion['status'], from: Date, to: Date | null): TimelineVersion => ({
  id: `v${version}`,
  version,
  status,
  effectiveFrom: from,
  effectiveTo: to,
});

describe('policyPhase', () => {
  it('derives the phase from status and range', () => {
    expect(policyPhase(v(1, 'DRAFT', h(-1), null), now)).toBe('DRAFT');
    expect(policyPhase(v(1, 'PUBLISHED', h(1), null), now)).toBe('SCHEDULED');
    expect(policyPhase(v(1, 'PUBLISHED', h(-1), null), now)).toBe('CURRENT');
    expect(policyPhase(v(1, 'PUBLISHED', h(-1), h(2)), now)).toBe('CURRENT');
    expect(policyPhase(v(1, 'PUBLISHED', h(-5), h(-1)), now)).toBe('ENDED');
    expect(policyPhase(v(1, 'RETIRED', h(-5), h(-1)), now)).toBe('RETIRED');
    expect(policyPhase(v(1, 'RETIRED', h(3), h(3)), now)).toBe('WITHDRAWN');
  });
});

describe('versionInEffect / nextScheduledVersion', () => {
  const versions = [v(1, 'PUBLISHED', h(-10), h(5)), v(2, 'PUBLISHED', h(5), null), v(3, 'RETIRED', h(2), h(2)), v(4, 'DRAFT', h(-1), null)];
  it('ignores drafts and withdrawn versions', () => {
    expect(versionInEffect(versions, now)?.version).toBe(1);
    expect(versionInEffect(versions, h(6))?.version).toBe(2);
    expect(nextScheduledVersion(versions, now)?.version).toBe(2);
    expect(nextScheduledVersion(versions, h(6))).toBeNull();
  });
});

describe('planPublication', () => {
  it('closes the open current version at T and stays open-ended', () => {
    const plan = planPublication([v(1, 'PUBLISHED', h(-10), null)], now);
    expect(plan).toEqual({
      ok: true,
      effectiveTo: null,
      close: { id: 'v1', version: 1, previousEffectiveTo: null, effectiveTo: now },
      next: null,
    });
  });

  it('ends the new version where a later scheduled version starts', () => {
    // v1 [−10h, +5h), v2 [+5h, ∞). Publishing at +1h: v1 → [−10h, +1h), new → [+1h, +5h).
    const plan = planPublication([v(1, 'PUBLISHED', h(-10), h(5)), v(2, 'PUBLISHED', h(5), null)], h(1));
    expect(plan.ok && plan.effectiveTo).toEqual(h(5));
    expect(plan.ok && plan.close).toMatchObject({ id: 'v1', effectiveTo: h(1), previousEffectiveTo: h(5) });
    expect(plan.ok && plan.next).toMatchObject({ id: 'v2' });
  });

  it('schedules after the current version without closing anything when T is in a gap', () => {
    const plan = planPublication([v(1, 'PUBLISHED', h(-10), h(-2))], now);
    expect(plan).toMatchObject({ ok: true, close: null, effectiveTo: null });
  });

  it('publishing a future version closes the current one at its start', () => {
    const plan = planPublication([v(1, 'PUBLISHED', h(-10), null)], h(24));
    expect(plan.ok && plan.close).toMatchObject({ id: 'v1', effectiveTo: h(24) });
  });

  it('refuses a start that collides with an existing version start', () => {
    expect(planPublication([v(1, 'PUBLISHED', h(-10), h(5)), v(2, 'PUBLISHED', h(5), null)], h(5))).toEqual({
      ok: false,
      code: 'START_COLLISION',
      conflictingVersion: 2,
    });
  });

  it('ignores withdrawn versions and refuses to overlap a retired range', () => {
    expect(planPublication([v(1, 'RETIRED', h(5), h(5))], h(5))).toMatchObject({ ok: true, close: null, effectiveTo: null });
    expect(planPublication([v(1, 'RETIRED', h(-10), h(1))], now)).toMatchObject({ ok: false, code: 'RETIRED_OVERLAP' });
  });
});

describe('planRetirement', () => {
  it('ends a current version now', () => {
    expect(planRetirement({ effectiveFrom: h(-10), effectiveTo: null }, now)).toEqual({ effectiveTo: now, withdrawn: false, alreadyEnded: false });
    expect(planRetirement({ effectiveFrom: h(-10), effectiveTo: h(5) }, now)).toEqual({ effectiveTo: now, withdrawn: false, alreadyEnded: false });
  });

  it('withdraws a version that has not started', () => {
    expect(planRetirement({ effectiveFrom: h(5), effectiveTo: h(9) }, now)).toEqual({ effectiveTo: h(5), withdrawn: true, alreadyEnded: false });
  });

  it('never extends a range that already ended', () => {
    expect(planRetirement({ effectiveFrom: h(-10), effectiveTo: h(-2) }, now)).toEqual({ effectiveTo: h(-2), withdrawn: false, alreadyEnded: true });
  });
});
