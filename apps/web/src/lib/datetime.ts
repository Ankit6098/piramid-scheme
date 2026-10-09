/**
 * Date/time helpers (date-fns v4 + @date-fns/tz). The API stores and returns UTC ISO strings;
 * display happens in an explicit IANA zone (a program's `timezone`, or the viewer's zone).
 * Pure functions — no "current time" reads (pass `now` in).
 */
import { TZDate, tz } from '@date-fns/tz';
import { format, formatDistanceStrict, isValid, parseISO } from 'date-fns';

export type DateInput = string | Date | number;

export type DateTimeStyle = 'date' | 'datetime' | 'time' | 'long' | 'short';

const PATTERNS: Record<DateTimeStyle, string> = {
  date: 'd MMM yyyy',
  datetime: 'd MMM yyyy, HH:mm',
  time: 'HH:mm',
  long: "EEEE, d MMMM yyyy 'at' HH:mm",
  short: 'd MMM',
};

export function toDate(value: DateInput): Date | null {
  const date = typeof value === 'string' ? parseISO(value) : new Date(value);
  return isValid(date) ? date : null;
}

/** Formats in `timeZone` (IANA). Without a zone, the runtime's zone is used — avoid on the server. */
export function formatDateTime(
  value: DateInput,
  options: { timeZone?: string | null; style?: DateTimeStyle; pattern?: string } = {},
): string {
  const date = toDate(value);
  if (!date) return '—';
  const pattern = options.pattern ?? PATTERNS[options.style ?? 'datetime'];
  try {
    return options.timeZone
      ? format(date, pattern, { in: tz(options.timeZone) })
      : format(date, pattern);
  } catch {
    return format(date, pattern);
  }
}

/** Short zone label for a moment in time, e.g. "GMT+5:30". */
export function timeZoneLabel(timeZone: string, at: DateInput = 0): string {
  const date = toDate(at) ?? new Date(0);
  try {
    return format(date, 'zzz', { in: tz(timeZone) });
  } catch {
    return timeZone;
  }
}

/** UTC ISO → value for `<input type="datetime-local">` in `timeZone` ("2026-10-10T14:30"). */
export function isoToLocalInput(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '';
  const date = toDate(iso);
  if (!date) return '';
  return format(new TZDate(date.getTime(), timeZone), "yyyy-MM-dd'T'HH:mm");
}

/** `datetime-local` value interpreted in `timeZone` → UTC ISO string (null if invalid/empty). */
export function localInputToIso(value: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const date = new TZDate(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? 0),
    timeZone,
  );
  return isValid(date) ? new Date(date.getTime()).toISOString() : null;
}

/** "3 minutes ago" / "in 2 days" relative to `now` (ms). */
export function formatRelative(value: DateInput, now: number): string {
  const date = toDate(value);
  if (!date) return '—';
  if (Math.abs(now - date.getTime()) < 45_000) return 'just now';
  return formatDistanceStrict(date, now, { addSuffix: true });
}
