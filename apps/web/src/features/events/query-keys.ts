/**
 * TanStack Query keys for the sales events feature (admin). Root `['events']` — invalidate it after
 * any mutation that changes a sale (record, reverse).
 */
export type EventListParams = Record<string, string | undefined>;

export const eventKeys = {
  all: ['events'] as const,
  /** GET /admin/events/programs — programs for filters and the "Record sale" form. */
  programs: () => ['events', 'programs'] as const,
  /** GET /admin/events (cursor list; `useCursorList` appends the page size). */
  list: (params: EventListParams) => ['events', 'list', params] as const,
  /** GET /admin/events/:id */
  detail: (id: string) => ['events', 'detail', id] as const,
};
