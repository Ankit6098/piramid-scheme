/**
 * TanStack Query keys for the reward-policies feature. Everything hangs off the `['policies']` root so
 * mutations can invalidate the whole feature with `queryClient.invalidateQueries({ queryKey: policyKeys.all })`.
 */
export const policyKeys = {
  all: ['policies'] as const,
  /** GET /admin/programs/:programId/policy-context */
  context: (programId: string) => ['policies', 'context', programId] as const,
  /** GET /admin/programs/:programId/policies (cursor list; `useCursorList` appends `{ limit }`). */
  list: (programId: string) => ['policies', 'list', programId] as const,
  /** GET /admin/policies/:id */
  detail: (id: string) => ['policies', 'detail', id] as const,
  /**
   * POST /admin/policies/:id/validate used as a read-only query. `basedOn` = the draft's `updatedAt`
   * the request was built from; `body` = the JSON request body (so equal bodies share a cache entry).
   */
  validation: (id: string, basedOn: string, body: string) =>
    ['policies', 'validation', id, basedOn, body] as const,
};
