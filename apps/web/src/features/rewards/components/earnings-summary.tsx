'use client';

/**
 * STUB — owned by the rewards slice, which replaces the internals with real data from the member
 * earnings endpoint (per unit/currency bucket: earned to date, pending, reversed — see
 * docs/business-rules.md §10). Keep the export name and props stable: the dashboard uses it.
 *
 * Copy rules: show only recorded figures. Never project, estimate or promise future earnings.
 */
import { Gift } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export interface EarningsSummaryProps {
  /**
   * `card` — full card with the three totals (dashboard, rewards page header).
   * `compact` — single-line summary for sidebars and small widgets.
   */
  variant: 'card' | 'compact';
  className?: string;
}

/** Member earnings totals (earned to date / pending / reversed). */
export function EarningsSummary({ variant, className }: EarningsSummaryProps) {
  if (variant === 'compact') {
    return (
      <div className={cn('flex items-center gap-3', className)} aria-busy>
        <Gift className="size-4 text-muted-foreground" aria-hidden />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-16" />
        <span className="sr-only">Loading earnings</span>
      </div>
    );
  }

  return (
    <Card className={className} aria-busy>
      <CardHeader>
        <CardTitle>Earnings</CardTitle>
        <CardDescription>Rewards from qualifying sales of approved offerings.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-3">
        {['Earned to date', 'Pending', 'Reversed'].map((label) => (
          <div key={label} className="space-y-2">
            <p className="text-sm text-muted-foreground">{label}</p>
            <Skeleton className="h-7 w-28" />
          </div>
        ))}
        <span className="sr-only">Loading earnings</span>
      </CardContent>
    </Card>
  );
}
