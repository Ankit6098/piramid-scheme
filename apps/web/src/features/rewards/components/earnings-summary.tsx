'use client';

/**
 * Member earnings totals from `GET /users/me/earnings`, per (unit, currency) bucket
 * (docs/business-rules.md §10): earned to date (posted − reversed, from the ledger), pending
 * (awaiting approval) and reversed. Rejected rewards are never totalled. Used by the dashboard
 * (`compact`) and the rewards page / profile (`card`).
 *
 * Copy rules: show only recorded figures. Never project, estimate or promise future earnings.
 */
import { CircleAlert, Gift, RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';
import type { EarningsBucketDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { getErrorMessage } from '@/lib/api-client';
import { cn } from '@/lib/utils';

import { unitFormat } from '../../finance/lib';
import { useEarnings } from '../api';

export interface EarningsSummaryProps {
  /**
   * `card` — full card with the three totals (dashboard, rewards page header).
   * `compact` — single-line summary for sidebars and small widgets.
   */
  variant: 'card' | 'compact';
  className?: string;
}

const ZERO = '0';

function bucketLabel(bucket: EarningsBucketDto): string {
  return bucket.rewardUnit === 'POINTS' ? 'Points' : bucket.currencyCode;
}

/** Member earnings totals (earned to date / pending / reversed). */
export function EarningsSummary({ variant, className }: EarningsSummaryProps) {
  const { data, isPending, error, refetch } = useEarnings();

  if (isPending) return <EarningsSkeleton variant={variant} className={className} />;

  if (error) {
    return variant === 'compact' ? (
      <div className={cn('flex items-center gap-2 text-sm text-muted-foreground', className)} role="alert">
        <CircleAlert className="size-4 text-destructive" aria-hidden />
        <span>Earnings unavailable.</span>
        <Button variant="link" size="sm" className="h-auto p-0" onClick={() => void refetch()}>
          Retry
        </Button>
      </div>
    ) : (
      <Card className={className}>
        <CardHeader>
          <CardTitle>Earnings</CardTitle>
          <CardDescription role="alert">{getErrorMessage(error, 'Your earnings could not be loaded.')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            <RotateCcw aria-hidden />
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  const buckets = data.buckets;

  if (variant === 'compact') {
    if (buckets.length === 0) {
      return (
        <div className={cn('flex items-center gap-3 text-sm', className)}>
          <Gift className="size-4 text-muted-foreground" aria-hidden />
          <span className="text-muted-foreground">Earned to date</span>
          <Amount value={ZERO} className="font-semibold" />
        </div>
      );
    }
    return (
      <ul className={cn('space-y-2', className)} aria-label="Earnings">
        {buckets.map((b) => (
          <li key={`${b.rewardUnit}:${b.currencyCode}`} className="space-y-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-muted-foreground">
                Earned to date{buckets.length > 1 ? ` · ${bucketLabel(b)}` : ''}
              </span>
              <Amount value={b.earnedToDateMinor} format={unitFormat(b)} className="text-base font-semibold" />
            </div>
            <div className="flex flex-wrap justify-end gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <span>
                Pending <Amount value={b.pendingMinor} format={unitFormat(b)} />
              </span>
              {b.reversedMinor !== ZERO ? (
                <span>
                  Reversed <Amount value={b.reversedMinor} format={unitFormat(b)} />
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Earnings</CardTitle>
        <CardDescription>
          Rewards recorded from qualifying sales of approved offerings. Earned to date counts posted rewards minus
          reversals; rejected rewards are not included.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {buckets.length === 0 ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <Figure label="Earned to date" value={<Amount value={ZERO} />} hint="No rewards recorded yet" />
            <Figure label="Pending" value={<Amount value={ZERO} />} />
            <Figure label="Reversed" value={<Amount value={ZERO} />} />
          </div>
        ) : (
          buckets.map((b) => (
            <div key={`${b.rewardUnit}:${b.currencyCode}`} className="space-y-2">
              {buckets.length > 1 ? (
                <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{bucketLabel(b)}</p>
              ) : null}
              <div className="grid gap-4 sm:grid-cols-3">
                <Figure
                  label="Earned to date"
                  value={<Amount value={b.earnedToDateMinor} format={unitFormat(b)} />}
                  hint={`${b.postedCount} posted ${b.postedCount === 1 ? 'reward' : 'rewards'}`}
                  emphasis
                />
                <Figure
                  label="Pending"
                  value={<Amount value={b.pendingMinor} format={unitFormat(b)} />}
                  hint={b.pendingCount > 0 ? `${b.pendingCount} awaiting approval` : 'Nothing awaiting approval'}
                />
                <Figure
                  label="Reversed"
                  value={<Amount value={b.reversedMinor} format={unitFormat(b)} />}
                  hint={b.reversedCount > 0 ? `${b.reversedCount} reversed after posting` : 'No reversals'}
                />
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function Figure({
  label,
  value,
  hint,
  emphasis,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  emphasis?: boolean;
}) {
  return (
    <div className={cn('space-y-1 rounded-lg border px-3 py-2.5', emphasis ? 'bg-primary/5 border-primary/20' : 'bg-muted/30')}>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="font-heading text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function EarningsSkeleton({ variant, className }: EarningsSummaryProps) {
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
        <CardDescription>Rewards recorded from qualifying sales of approved offerings.</CardDescription>
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
