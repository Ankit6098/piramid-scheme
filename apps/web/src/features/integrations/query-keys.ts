/**
 * TanStack Query keys for the integrations feature (API clients). Root `['integrations']`.
 * The one-time API key is NEVER stored under any query key.
 */
export type ApiClientListParams = Record<string, string | undefined>;

export const integrationKeys = {
  all: ['integrations'] as const,
  /** GET /admin/integrations/clients (cursor list; `useCursorList` appends the page size). */
  clients: (params: ApiClientListParams) => ['integrations', 'clients', params] as const,
};
