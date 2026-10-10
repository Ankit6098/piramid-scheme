'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';
import {
  QualifyingEventSource,
  QualifyingEventStatus,
  QualifyingEventType,
} from '@app/shared';

import { localInputToIso } from '@/lib/datetime';

/** URL search params of the sales page (shareable links). */
export const EVENT_PARAM = {
  program: 'program',
  status: 'status',
  type: 'type',
  source: 'source',
  from: 'from',
  to: 'to',
  q: 'q',
  /** Id of the sale shown in the detail drawer. */
  event: 'event',
} as const;

const FILTER_PARAMS = [
  EVENT_PARAM.program,
  EVENT_PARAM.status,
  EVENT_PARAM.type,
  EVENT_PARAM.source,
  EVENT_PARAM.from,
  EVENT_PARAM.to,
  EVENT_PARAM.q,
] as const;

export interface EventFilters {
  programId?: string;
  status?: QualifyingEventStatus;
  type?: QualifyingEventType;
  source?: QualifyingEventSource;
  /** Inclusive start date (yyyy-MM-dd) in the display zone. */
  from?: string;
  /** Inclusive end date (yyyy-MM-dd) in the display zone. */
  to?: string;
  q?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function pick<T extends string>(values: readonly T[], raw: string | null): T | undefined {
  return raw && (values as readonly string[]).includes(raw) ? (raw as T) : undefined;
}

export function parseEventFilters(params: URLSearchParams | { get(name: string): string | null }) {
  const program = params.get(EVENT_PARAM.program);
  const from = params.get(EVENT_PARAM.from);
  const to = params.get(EVENT_PARAM.to);
  const q = params.get(EVENT_PARAM.q)?.trim();
  const filters: EventFilters = {
    programId: isUuid(program) ? program : undefined,
    status: pick(QualifyingEventStatus, params.get(EVENT_PARAM.status)),
    type: pick(QualifyingEventType, params.get(EVENT_PARAM.type)),
    source: pick(QualifyingEventSource, params.get(EVENT_PARAM.source)),
    from: from && DATE_RE.test(from) ? from : undefined,
    to: to && DATE_RE.test(to) ? to : undefined,
    q: q ? q.slice(0, 128) : undefined,
  };
  return filters;
}

export function hasActiveFilters(filters: EventFilters): boolean {
  return Object.values(filters).some((value) => value !== undefined && value !== '');
}

/** "2026-10-10" → "2026-10-11" (pure calendar arithmetic, no time zone involved). */
export function nextCalendarDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + 1)).toISOString().slice(0, 10);
}

/**
 * API query for `GET /admin/events`: dates become the start of the day in `timeZone`
 * (`from` inclusive, `to` exclusive = start of the day after the chosen end date).
 */
export function toEventListQuery(
  filters: EventFilters,
  timeZone: string,
): Record<string, string | undefined> {
  return {
    programId: filters.programId,
    status: filters.status,
    type: filters.type,
    source: filters.source,
    from: filters.from ? (localInputToIso(`${filters.from}T00:00`, timeZone) ?? undefined) : undefined,
    to: filters.to
      ? (localInputToIso(`${nextCalendarDay(filters.to)}T00:00`, timeZone) ?? undefined)
      : undefined,
    q: filters.q,
  };
}

export type EventParamPatch = Partial<
  Record<(typeof EVENT_PARAM)[keyof typeof EVENT_PARAM], string | null>
>;

function buildHref(pathname: string, params: URLSearchParams, patch: EventParamPatch): string {
  for (const [key, value] of Object.entries(patch)) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/**
 * Filters + the open sale live in the URL (`router.replace`, no scroll) so views are shareable and
 * survive reloads.
 */
export function useEventFilters() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const filters = useMemo(() => parseEventFilters(searchParams), [searchParams]);
  const rawEventId = searchParams.get(EVENT_PARAM.event);
  const openEventId = rawEventId && rawEventId.trim() ? rawEventId.trim() : null;

  /**
   * Applies a patch to the CURRENT url (read at call time, so debounced/async callers never
   * restore stale params). null/"" removes a param.
   */
  const setParams = useCallback(
    (patch: EventParamPatch) =>
      router.replace(buildHref(pathname, new URLSearchParams(window.location.search), patch), {
        scroll: false,
      }),
    [router, pathname],
  );

  const resetFilters = useCallback(
    () =>
      setParams(Object.fromEntries(FILTER_PARAMS.map((key) => [key, null])) as EventParamPatch),
    [setParams],
  );

  /** Href that opens a sale in the drawer while keeping the current filters. */
  const eventHref = useCallback(
    (id: string) =>
      buildHref(pathname, new URLSearchParams(searchParams.toString()), {
        [EVENT_PARAM.event]: id,
      }),
    [pathname, searchParams],
  );
  const openEvent = useCallback(
    (id: string) => setParams({ [EVENT_PARAM.event]: id }),
    [setParams],
  );
  const closeEvent = useCallback(() => setParams({ [EVENT_PARAM.event]: null }), [setParams]);

  return { filters, openEventId, setParams, resetFilters, eventHref, openEvent, closeEvent };
}
