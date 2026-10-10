/**
 * Turns `from` / `to` query values (ISO date-time with offset, or `YYYY-MM-DD`) into a half-open
 * range `[gte, lt)`. A calendar date means the UTC day: `from` = its start, `to` = the start of the
 * next day (so `to=2026-10-10` includes the whole 10th). Pure.
 */
export interface DateRange {
  gte?: Date;
  lt?: Date;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export function parseDateBound(value: string, bound: 'from' | 'to'): Date {
  if (DATE_ONLY.test(value)) {
    const start = new Date(`${value}T00:00:00.000Z`);
    return bound === 'from' ? start : new Date(start.getTime() + DAY_MS);
  }
  return new Date(value);
}

export function resolveDateRange(from?: string, to?: string): DateRange | undefined {
  const range: DateRange = {};
  if (from) range.gte = parseDateBound(from, 'from');
  if (to) range.lt = parseDateBound(to, 'to');
  return range.gte || range.lt ? range : undefined;
}
