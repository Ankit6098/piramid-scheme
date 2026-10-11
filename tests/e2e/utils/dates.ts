/** Value for an <input type="datetime-local"> showing `date` in `timeZone` (yyyy-MM-ddTHH:mm). */
export function zonedInputValue(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** The start of the next full minute (at least `minAheadMs` from now). */
export function nextFullMinute(minAheadMs = 1_000): Date {
  return new Date(Math.ceil((Date.now() + minAheadMs) / 60_000) * 60_000);
}
