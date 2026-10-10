'use client';

import { BadgeCheck, Layers, UserCheck, Users } from 'lucide-react';
import type { TeamSummaryResponse } from '@app/shared';

import { StatCard } from '@/components/app/stat-card';
import { Skeleton } from '@/components/ui/skeleton';

import { depthColor } from '../model';

/** KPI row for the team (counts only — never amounts). */
export function TeamStats({ summary, loading }: { summary: TeamSummaryResponse | undefined; loading: boolean }) {
  const limitHint = summary?.maxDepth ? `Up to ${summary.maxDepth} levels` : 'Whole team';
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard label="Direct referrals" value={summary?.directCount ?? 0} icon={Users} loading={loading} hint="Level 1" />
      <StatCard label="Team size" value={summary?.teamSize ?? 0} icon={Layers} loading={loading} hint={limitHint} />
      <StatCard
        label="Active accounts"
        value={summary?.activeCount ?? 0}
        icon={UserCheck}
        loading={loading}
        hint={summary ? `${summary.inactiveCount} inactive` : undefined}
      />
      <StatCard
        label="Enrolled now"
        value={summary?.withEligibleEnrollmentCount ?? 0}
        icon={BadgeCheck}
        loading={loading}
        hint="Hold an eligible enrollment"
      />
    </div>
  );
}

/** Depth legend with member counts per level (sequential single-hue swatches + text labels). */
export function DepthLegend({ summary, loading }: { summary: TeamSummaryResponse | undefined; loading: boolean }) {
  if (loading) return <Skeleton className="h-6 w-full max-w-lg" />;
  const rows = summary?.countsByDepth ?? [];
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">Members by level</span>
      <ul className="flex flex-wrap gap-1.5" aria-label="Members by level">
        {rows.map((r) => (
          <li key={r.depth} className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5">
            <span className="size-2 rounded-full" style={{ background: depthColor(r.depth) }} aria-hidden />
            <span>L{r.depth}</span>
            <span className="font-medium text-foreground tabular-nums">{r.count}</span>
          </li>
        ))}
      </ul>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-3 w-5 rounded-sm border border-dashed border-input bg-muted" aria-hidden />
        Inactive
      </span>
      <span className="inline-flex items-center gap-1">
        <BadgeCheck className="size-3.5 text-primary" aria-hidden />
        Enrolled
      </span>
    </div>
  );
}
