import type { LucideIcon } from 'lucide-react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import type { ReactNode } from 'react';

import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export interface StatTrend {
  /** Pre-formatted change, e.g. "+12%" or an `<Amount signed>` element. */
  value: ReactNode;
  direction: 'up' | 'down' | 'flat';
  /** Whether "up" is good (default) — controls the color, not the arrow. */
  upIsGood?: boolean;
  /** e.g. "vs last 30 days". */
  label?: string;
}

export interface StatCardProps {
  label: ReactNode;
  /** The headline figure. Pass `<Amount …/>` for money/points — never a hand-formatted number. */
  value: ReactNode;
  /** Secondary line under the value (context, definitions). */
  hint?: ReactNode;
  trend?: StatTrend;
  icon?: LucideIcon;
  loading?: boolean;
  /** Optional footer action/link. */
  footer?: ReactNode;
  className?: string;
}

/** KPI tile. Plain figures, no charts; keep labels short. */
export function StatCard({
  label,
  value,
  hint,
  trend,
  icon: Icon,
  loading,
  footer,
  className,
}: StatCardProps) {
  return (
    <Card size="sm" className={cn('gap-0', className)} aria-busy={loading || undefined}>
      <div className="flex flex-col gap-2 px-(--card-spacing)">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          {Icon ? (
            <span className="flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Icon className="size-4" aria-hidden />
            </span>
          ) : null}
        </div>
        {loading ? (
          <div className="space-y-2 py-0.5">
            <Skeleton className="h-7 w-28" />
            <Skeleton className="h-3.5 w-36" />
            <span className="sr-only">Loading</span>
          </div>
        ) : (
          <>
            <div className="font-heading text-2xl font-semibold tracking-tight tabular-nums">
              {value}
            </div>
            {trend || hint ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                {trend ? <TrendPill trend={trend} /> : null}
                {hint ? <span>{hint}</span> : null}
              </div>
            ) : null}
          </>
        )}
      </div>
      {footer ? (
        <div className="mt-3 border-t px-(--card-spacing) pt-2.5 text-sm">{footer}</div>
      ) : null}
    </Card>
  );
}

function TrendPill({ trend }: { trend: StatTrend }) {
  const good =
    trend.direction === 'flat' ? null : (trend.direction === 'up') === (trend.upIsGood ?? true);
  const Icon =
    trend.direction === 'up' ? ArrowUpRight : trend.direction === 'down' ? ArrowDownRight : Minus;
  const directionLabel =
    trend.direction === 'up' ? 'Increased' : trend.direction === 'down' ? 'Decreased' : 'No change';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 font-medium tabular-nums',
        good === true && 'text-success',
        good === false && 'text-destructive',
        good === null && 'text-muted-foreground',
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      <span className="sr-only">{directionLabel}:</span>
      {trend.value}
      {trend.label ? (
        <span className="font-normal text-muted-foreground">&nbsp;{trend.label}</span>
      ) : null}
    </span>
  );
}
