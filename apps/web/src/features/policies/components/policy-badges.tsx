'use client';

import { ArrowRight } from 'lucide-react';
import type { PolicyPhase } from '@app/shared';

import { DateTime } from '@/components/app/date-time';
import { ToneBadge } from '@/components/app/status-badge';
import type { StatusTone } from '@/lib/enum-labels';
import { cn } from '@/lib/utils';

import { phaseMeta } from '../labels';

/** Phase pill (label + tone; the label is text so meaning never relies on color). */
export function PolicyPhaseBadge({ phase, className }: { phase: PolicyPhase; className?: string }) {
  const meta = phaseMeta(phase);
  return (
    <ToneBadge tone={meta.tone} title={meta.description} className={className}>
      {meta.label}
    </ToneBadge>
  );
}

/** Solid fill per tone, for timeline dots. */
export const TONE_DOT_CLASS: Record<StatusTone, string> = {
  neutral: 'bg-muted-foreground/60',
  muted: 'bg-muted-foreground/35',
  primary: 'bg-primary',
  info: 'bg-info',
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  'destructive-outline': 'bg-background ring-2 ring-inset ring-destructive/60',
};

export interface EffectiveRangeProps {
  phase: PolicyPhase;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  /** Program time zone (IANA). */
  timeZone: string;
  showTimeZone?: boolean;
  style?: 'date' | 'datetime';
  className?: string;
}

/**
 * Effective range `[from → to)` in the program's time zone: "open-ended" without an end, "Not
 * published" for drafts and an explicit note for withdrawn versions (empty range).
 */
export function EffectiveRange({
  phase,
  effectiveFrom,
  effectiveTo,
  timeZone,
  showTimeZone,
  style = 'datetime',
  className,
}: EffectiveRangeProps) {
  if (phase === 'DRAFT' || !effectiveFrom) {
    return <span className={cn('text-muted-foreground', className)}>Not published</span>;
  }
  if (phase === 'WITHDRAWN') {
    return (
      <span className={cn('text-muted-foreground', className)}>Withdrawn before taking effect</span>
    );
  }
  return (
    <span
      className={cn('inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5', className)}
      title="Applies to sales from the start time up to, but not including, the end time"
    >
      <span className="sr-only">Effective from</span>
      <DateTime
        value={effectiveFrom}
        timeZone={timeZone}
        style={style}
        showTimeZone={showTimeZone}
      />
      <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="sr-only">until</span>
      {effectiveTo ? (
        <DateTime
          value={effectiveTo}
          timeZone={timeZone}
          style={style}
          showTimeZone={showTimeZone}
        />
      ) : (
        <span className="text-muted-foreground">open-ended</span>
      )}
    </span>
  );
}
