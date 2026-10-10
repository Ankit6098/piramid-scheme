'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  ApiClientDto,
  CreateApiClientInput,
  CreatedApiClientDto,
  RevokeApiClientInput,
} from '@app/shared';

import { api } from '@/lib/api-client';

import { integrationKeys } from './query-keys';

/** Path of the cursor-paginated API client list (used with `useCursorList`). */
export const API_CLIENTS_PATH = '/admin/integrations/clients';

/**
 * POST /admin/integrations/clients → `{ client, apiKey }`. The key is returned once: the caller
 * moves it into dialog state and resets the mutation; `gcTime: 0` drops it from the mutation cache
 * as soon as nothing observes it.
 */
export function useCreateApiClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateApiClientInput) =>
      api.post<CreatedApiClientDto>(API_CLIENTS_PATH, input),
    gcTime: 0,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: integrationKeys.all });
    },
  });
}

/** POST /admin/integrations/clients/:id/revoke (409 INVALID_STATE_TRANSITION if already revoked). */
export function useRevokeApiClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: RevokeApiClientInput }) =>
      api.post<ApiClientDto>(`${API_CLIENTS_PATH}/${encodeURIComponent(id)}/revoke`, input),
    // Not awaited: the confirm dialog closes before the row re-renders as REVOKED (which removes it).
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: integrationKeys.all });
    },
  });
}
