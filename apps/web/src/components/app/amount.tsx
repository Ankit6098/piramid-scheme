'use client';

import type { ReactNode } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  useFormatAmount,
  type AmountFormatOverride,
  type MinorAmount,
} from '@/providers/platform-settings-provider';

export type AmountTone = 'default' | 'muted' | 'success' | 'warning' | 'destructive' | 'auto';

export interface AmountProps {
  /** Integer minor units as delivered by the API (decimal string) or bigint. `null` renders the fallback. */
  value: MinorAmount | null | undefined;
  /**
   * `reward` (default) formats in the reward unit (money or points); `currency` always formats as
   * money — use it for prices and sale amounts.
   */
  kind?: 'reward' | 'currency';
  /** Stored unit/currency of this value (program snapshot, reward row). Defaults to platform settings. */
  format?: AmountFormatOverride;
  /** Text color. `auto` = destructive for negatives, default otherwise. */
  tone?: AmountTone;
  /** Prefix positive values with "+" (ledger deltas, reversals). */
  signed?: boolean;
  /** Rendered when `value` is null/undefined. */
  fallback?: ReactNode;
  className?: string;
}

const TONE_CLASS: Record<Exclude<AmountTone, 'auto'>, string> = {
  default: '',
  muted: 'text-muted-foreground',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
};

function isNegative(value: MinorAmount): boolean {
  return typeof value === 'bigint' ? value < BigInt(0) : value.trim().startsWith('-');
}

function isZero(value: MinorAmount): boolean {
  return typeof value === 'bigint' ? value === BigInt(0) : /^-?0+$/.test(value.trim());
}

/**
 * Renders an amount through the platform formatter (never format money by hand). Uses tabular
 * figures so columns align.
 *
 * @example <Amount value={reward.amountMinor} format={{ unit: reward.unit, currencyCode: reward.currencyCode }} />
 * @example <Amount kind="currency" value={option.priceMinor} format={{ currencyCode: program.currencyCode }} />
 */
export function Amount({
  value,
  kind = 'reward',
  format,
  tone = 'default',
  signed = false,
  fallback = '—',
  className,
}: AmountProps) {
  const { formatAmount, formatCurrency, isReady } = useFormatAmount();

  if (value === null || value === undefined || value === '') {
    return <span className={cn('text-muted-foreground tabular-nums', className)}>{fallback}</span>;
  }

  const hasOwnFormat =
    kind === 'currency'
      ? Boolean(format?.currencyCode)
      : Boolean(format?.unit && format?.currencyCode);
  if (!isReady && !hasOwnFormat) {
    return (
      <span className={cn('inline-flex align-middle', className)}>
        <Skeleton className="h-[1em] w-16" aria-hidden />
        <span className="sr-only">Loading amount</span>
      </span>
    );
  }

  const text =
    kind === 'currency'
      ? formatCurrency(value, {
          currencyCode: format?.currencyCode,
          minorUnits: format?.minorUnits,
        })
      : formatAmount(value, format);
  const negative = isNegative(value);
  const resolvedTone = tone === 'auto' ? (negative ? 'destructive' : 'default') : tone;
  const prefix = signed && !negative && !isZero(value) ? '+' : '';

  return (
    <span
      data-slot="amount"
      className={cn('whitespace-nowrap tabular-nums', TONE_CLASS[resolvedTone], className)}
    >
      {prefix}
      {text}
    </span>
  );
}
