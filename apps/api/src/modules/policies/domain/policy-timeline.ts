/**
 * Pure effective-dating rules for policy versions (business rules §7). Ranges are half-open
 * `[effectiveFrom, effectiveTo)`; `effectiveTo = null` is open-ended; a RETIRED version with
 * `effectiveTo = effectiveFrom` was withdrawn before taking effect (empty range, overlaps nothing).
 */
import type { PolicyPhase, PolicyStatus } from '@app/shared';

export interface TimelineVersion {
  id: string;
  version: number;
  status: PolicyStatus;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

const isEmptyRange = (v: Pick<TimelineVersion, 'effectiveFrom' | 'effectiveTo'>) =>
  v.effectiveTo !== null && v.effectiveTo.getTime() === v.effectiveFrom.getTime();

const contains = (v: Pick<TimelineVersion, 'effectiveFrom' | 'effectiveTo'>, at: Date) =>
  v.effectiveFrom.getTime() <= at.getTime() && (v.effectiveTo === null || v.effectiveTo.getTime() > at.getTime());

/** Where a version sits on the timeline relative to `now`. */
export function policyPhase(v: Pick<TimelineVersion, 'status' | 'effectiveFrom' | 'effectiveTo'>, now: Date): PolicyPhase {
  if (v.status === 'DRAFT') return 'DRAFT';
  if (v.status === 'RETIRED') return isEmptyRange(v) ? 'WITHDRAWN' : 'RETIRED';
  if (v.effectiveFrom.getTime() > now.getTime()) return 'SCHEDULED';
  if (v.effectiveTo === null || v.effectiveTo.getTime() > now.getTime()) return 'CURRENT';
  return 'ENDED';
}

/** The non-draft version whose range contains `at` (at most one: ranges never overlap). */
export function versionInEffect<T extends TimelineVersion>(versions: readonly T[], at: Date): T | null {
  return versions.find((v) => v.status !== 'DRAFT' && !isEmptyRange(v) && contains(v, at)) ?? null;
}

/** The earliest non-draft, non-withdrawn version starting strictly after `at`. */
export function nextScheduledVersion<T extends TimelineVersion>(versions: readonly T[], at: Date): T | null {
  return (
    versions
      .filter((v) => v.status !== 'DRAFT' && !isEmptyRange(v) && v.effectiveFrom.getTime() > at.getTime())
      .sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime())[0] ?? null
  );
}

export type PublicationPlan =
  | {
      ok: true;
      /** The new version's end: the start of the next scheduled version, or open-ended. */
      effectiveTo: Date | null;
      /** The version in effect at `at`, closed there. */
      close: { id: string; version: number; previousEffectiveTo: Date | null; effectiveTo: Date } | null;
      next: { id: string; version: number; effectiveFrom: Date } | null;
    }
  | { ok: false; code: 'START_COLLISION' | 'RETIRED_OVERLAP'; conflictingVersion: number };

/**
 * Publish at `at`: close the version whose range contains `at` at `at`; if a version starts later
 * at S, the new version gets `effectiveTo = S`. A version already starting exactly at `at`, or a
 * (frozen) RETIRED range containing `at`, makes the plan impossible.
 */
export function planPublication(versions: readonly TimelineVersion[], at: Date): PublicationPlan {
  const live = versions.filter((v) => v.status !== 'DRAFT' && !isEmptyRange(v));
  const collision = live.find((v) => v.effectiveFrom.getTime() === at.getTime());
  if (collision) return { ok: false, code: 'START_COLLISION', conflictingVersion: collision.version };

  const containing = live.find((v) => contains(v, at)) ?? null;
  if (containing && containing.status !== 'PUBLISHED') {
    return { ok: false, code: 'RETIRED_OVERLAP', conflictingVersion: containing.version };
  }
  const next = nextScheduledVersion(live, at);
  return {
    ok: true,
    effectiveTo: next ? next.effectiveFrom : null,
    close: containing
      ? { id: containing.id, version: containing.version, previousEffectiveTo: containing.effectiveTo, effectiveTo: at }
      : null,
    next: next ? { id: next.id, version: next.version, effectiveFrom: next.effectiveFrom } : null,
  };
}

export interface RetirementPlan {
  effectiveTo: Date;
  /** The version had not started yet: retiring withdraws it (empty range). */
  withdrawn: boolean;
  /** The range already ended before now (closed by a successor); only the status changes. */
  alreadyEnded: boolean;
}

/** Retire: `effectiveTo = max(now, effectiveFrom)`, never extending an already-closed range. */
export function planRetirement(v: Pick<TimelineVersion, 'effectiveFrom' | 'effectiveTo'>, now: Date): RetirementPlan {
  const target = v.effectiveFrom.getTime() > now.getTime() ? v.effectiveFrom : now;
  if (v.effectiveTo !== null && v.effectiveTo.getTime() <= target.getTime()) {
    return { effectiveTo: v.effectiveTo, withdrawn: isEmptyRange(v), alreadyEnded: true };
  }
  return { effectiveTo: target, withdrawn: v.effectiveFrom.getTime() > now.getTime(), alreadyEnded: false };
}
