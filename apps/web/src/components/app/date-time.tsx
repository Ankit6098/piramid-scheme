'use client';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useNow } from '@/hooks/use-now';
import { useBrowserTimeZone } from '@/hooks/use-time-zone';
import {
  formatDateTime,
  formatRelative,
  timeZoneLabel,
  toDate,
  type DateInput,
  type DateTimeStyle,
} from '@/lib/datetime';
import { cn } from '@/lib/utils';

export interface DateTimeProps {
  value: DateInput | null | undefined;
  /** IANA zone to display in (e.g. the program's `timezone`). Defaults to the viewer's zone. */
  timeZone?: string | null;
  style?: DateTimeStyle;
  /** date-fns pattern; overrides `style`. */
  pattern?: string;
  /** Append the zone abbreviation ("GMT+5:30"). Useful when showing a program's zone. */
  showTimeZone?: boolean;
  fallback?: React.ReactNode;
  className?: string;
}

/**
 * Absolute date/time in a specific zone, rendered as `<time>` with the full timestamp as a tooltip.
 * Before hydration (server) it renders in UTC; the client immediately re-renders in the right zone.
 */
export function DateTime({
  value,
  timeZone,
  style = 'datetime',
  pattern,
  showTimeZone,
  fallback = '—',
  className,
}: DateTimeProps) {
  const browserZone = useBrowserTimeZone();
  const date = value === null || value === undefined ? null : toDate(value);
  if (!date) return <span className={cn('text-muted-foreground', className)}>{fallback}</span>;
  const zone = timeZone ?? browserZone ?? 'UTC';
  const text = formatDateTime(date, { timeZone: zone, style, pattern });
  const zoneText = showTimeZone ? ` ${timeZoneLabel(zone, date)}` : '';
  return (
    <time
      dateTime={date.toISOString()}
      title={`${formatDateTime(date, { timeZone: zone, style: 'long' })} (${zone})`}
      className={cn('whitespace-nowrap tabular-nums', className)}
    >
      {text}
      {zoneText}
    </time>
  );
}

export interface RelativeTimeProps {
  value: DateInput | null | undefined;
  /** Zone for the tooltip's absolute time. Defaults to the viewer's zone. */
  timeZone?: string | null;
  fallback?: React.ReactNode;
  className?: string;
}

/** "5 minutes ago", refreshed every 30 s; hover/focus shows the absolute time. */
export function RelativeTime({ value, timeZone, fallback = '—', className }: RelativeTimeProps) {
  const now = useNow();
  const browserZone = useBrowserTimeZone();
  const date = value === null || value === undefined ? null : toDate(value);
  if (!date) return <span className={cn('text-muted-foreground', className)}>{fallback}</span>;
  const zone = timeZone ?? browserZone ?? 'UTC';
  const absolute = formatDateTime(date, { timeZone: zone, style: 'datetime' });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          dateTime={date.toISOString()}
          tabIndex={0}
          className={cn(
            'whitespace-nowrap underline decoration-dotted decoration-muted-foreground/40 underline-offset-4',
            className,
          )}
        >
          {now === null ? absolute : formatRelative(date, now)}
        </time>
      </TooltipTrigger>
      <TooltipContent>
        {formatDateTime(date, { timeZone: zone, style: 'long' })} ({timeZoneLabel(zone, date)})
      </TooltipContent>
    </Tooltip>
  );
}
