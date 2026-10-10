'use client';

import { DateTime } from '@/components/app/date-time';

import { nodeLabel, type VisibleMember } from '../model';

/** Hover/focus card next to a canvas node (permitted fields only). */
export function NodeTooltip({ item, left, top }: { item: VisibleMember; left: number; top: number }) {
  const n = item.node;
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-20 w-56 rounded-lg bg-popover p-3 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10"
      style={{ left, top }}
    >
      <p className="truncate text-sm font-medium">{nodeLabel(n)}</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Level</dt>
        <dd className="tabular-nums">{n.depth}</dd>
        <dt className="text-muted-foreground">Joined</dt>
        <dd>
          <DateTime value={n.joinedAt} style="date" />
        </dd>
        <dt className="text-muted-foreground">Account</dt>
        <dd>{n.statusBucket === 'ACTIVE' ? 'Active' : 'Inactive'}</dd>
        <dt className="text-muted-foreground">Enrollment</dt>
        <dd>{n.hasEligibleEnrollment ? 'Enrolled now' : 'Not enrolled'}</dd>
        <dt className="text-muted-foreground">Referrals</dt>
        <dd className="tabular-nums">{n.childCount}</dd>
      </dl>
      {n.inScope === false ? (
        <p className="mt-2 text-muted-foreground">Not enrolled in your programs — limited details.</p>
      ) : null}
    </div>
  );
}
