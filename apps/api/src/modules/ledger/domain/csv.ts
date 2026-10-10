/**
 * CSV encoding for financial exports (RFC 4180) with spreadsheet formula-injection protection
 * (OWASP "CSV injection"): a text cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage
 * return is prefixed with a single quote so spreadsheet software treats it as text, never as a
 * formula. Pure functions — no I/O.
 */

export type CsvValue = string | number | bigint | boolean | Date | null | undefined;

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

/** Encodes one cell: neutralizes formula triggers, then quotes when needed. */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  let text: string;
  if (value instanceof Date) text = value.toISOString();
  else if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean') text = String(value);
  else text = value;

  if (FORMULA_TRIGGER.test(text)) text = `'${text}`;
  if (NEEDS_QUOTES.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** One CSV record terminated with CRLF. */
export function csvRow(values: readonly CsvValue[]): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}

/** UTF-8 byte-order mark so spreadsheet apps detect the encoding. */
export const CSV_BOM = '﻿';

/** `rewards-2026-10-10.csv` — the date is UTC. */
export function csvFilename(prefix: string, now: Date = new Date()): string {
  return `${prefix}-${now.toISOString().slice(0, 10)}.csv`;
}
