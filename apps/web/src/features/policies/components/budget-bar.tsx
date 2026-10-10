import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { shareOf } from '../format';

export interface BudgetBarProps {
  /** What is used (Σ percentage levels in bps, or allocated reward minor units). */
  allocated: bigint;
  /** The policy budget on the same scale. */
  budget: bigint;
  /** The absolute 50% ceiling on the same scale (bar end). */
  hardCap: bigint;
  /** Accessible summary, e.g. "Percentage levels 12% of a 20% budget (hard cap 50%)". */
  label: string;
  /** Legend under the bar (formatted values). */
  legend?: ReactNode;
  className?: string;
}

/**
 * Horizontal budget bar on a 0 → hard-cap scale: used part (teal, red beyond the budget), the
 * remaining budget (light teal) and the room between the budget and the 50% hard cap (muted), with a
 * marker at the budget. Presentational only — values come pre-computed from integer amounts.
 */
export function BudgetBar({
  allocated,
  budget,
  hardCap,
  label,
  legend,
  className,
}: BudgetBarProps) {
  const withinBudget = allocated < budget ? allocated : budget;
  const overBudget = allocated > budget ? allocated - budget : BigInt(0);
  const remaining = budget > allocated ? budget - allocated : BigInt(0);
  const usedPct = shareOf(withinBudget, hardCap);
  const overPct = Math.min(shareOf(overBudget, hardCap), 100 - usedPct);
  const remainingPct = Math.min(shareOf(remaining, hardCap), 100 - usedPct - overPct);
  const budgetPct = shareOf(budget, hardCap);

  return (
    <div className={cn('space-y-2', className)}>
      <div
        role="img"
        aria-label={label}
        className="relative h-3 w-full overflow-hidden rounded-full bg-muted ring-1 ring-inset ring-foreground/5"
      >
        <div className="absolute inset-y-0 left-0 flex w-full">
          <div className="h-full bg-primary" style={{ width: `${usedPct}%` }} />
          <div className="h-full bg-destructive" style={{ width: `${overPct}%` }} />
          <div className="h-full bg-primary/20" style={{ width: `${remainingPct}%` }} />
        </div>
        {budgetPct > 0 && budgetPct < 100 ? (
          <div
            aria-hidden
            className="absolute inset-y-0 w-0.5 bg-foreground/70"
            style={{ left: `calc(${budgetPct}% - 1px)` }}
          />
        ) : null}
      </div>
      {legend ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {legend}
        </div>
      ) : null}
    </div>
  );
}

/** Legend entry with a color swatch. */
export function BudgetLegendItem({
  swatch,
  children,
}: {
  swatch: 'used' | 'over' | 'remaining' | 'cap' | 'marker';
  children: ReactNode;
}) {
  const swatchClass = {
    used: 'bg-primary',
    over: 'bg-destructive',
    remaining: 'bg-primary/20',
    cap: 'bg-muted ring-1 ring-inset ring-foreground/15',
    marker: 'h-3 w-0.5 rounded-none bg-foreground/70',
  }[swatch];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={cn('size-2.5 shrink-0 rounded-sm', swatchClass)} />
      <span>{children}</span>
    </span>
  );
}
