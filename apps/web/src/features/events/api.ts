'use client';

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  RecordSaleInput,
  RecordSaleResultDto,
  SaleEventDetailDto,
  SaleProgramOptionDto,
} from '@app/shared';

import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

import { eventKeys } from './query-keys';

/** Path of the cursor-paginated sales list (used with `useCursorList`). */
export const SALE_EVENTS_PATH = '/admin/events';

export function saleProgramsQueryOptions() {
  return queryOptions({
    queryKey: eventKeys.programs(),
    queryFn: ({ signal }) => api.get<SaleProgramOptionDto[]>('/admin/events/programs', { signal }),
    staleTime: 60_000,
  });
}

/** Programs visible to the caller (filters, "Record sale" and API client forms). */
export function useSalePrograms(options: { enabled?: boolean } = {}) {
  return useQuery({ ...saleProgramsQueryOptions(), enabled: options.enabled ?? true });
}

export function saleEventQueryOptions(id: string) {
  return queryOptions({
    queryKey: eventKeys.detail(id),
    queryFn: ({ signal }) =>
      api.get<SaleEventDetailDto>(`/admin/events/${encodeURIComponent(id)}`, { signal }),
  });
}

/** One sale with its calculation trace, rewards and revisions. */
export function useSaleEvent(id: string | null) {
  return useQuery({ ...saleEventQueryOptions(id ?? ''), enabled: Boolean(id) });
}

function useInvalidateSales() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: eventKeys.all }),
      // Recording/reversing a sale creates or changes rewards owned by the rewards feature.
      queryClient.invalidateQueries({ queryKey: queryKeys.rewards.all }),
    ]);
}

export interface RecordSaleVariables {
  input: RecordSaleInput;
  /** Created once per "Record sale" sheet session so a retry reuses it. */
  idempotencyKey: string;
}

/** POST /admin/events — 201 (new) or 200 (replay of an identical request). */
export function useRecordSale() {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateSales();
  return useMutation({
    mutationFn: ({ input, idempotencyKey }: RecordSaleVariables) =>
      api.post<RecordSaleResultDto>(SALE_EVENTS_PATH, input, { idempotencyKey }),
    onSuccess: (result) => {
      queryClient.setQueryData(eventKeys.detail(result.event.id), result.event);
      // Not awaited: the result panel shows immediately, lists refresh in the background.
      void invalidate();
    },
  });
}

export interface ReverseSaleVariables {
  eventId: string;
  reason: string;
  /** Created once per dialog open. */
  idempotencyKey: string;
}

/**
 * POST /admin/events/:id/reverse — rejects or reverses every reward of the sale. Owned by the
 * rewards slice; it may answer 501 NOT_IMPLEMENTED until that slice lands.
 */
export function useReverseSale() {
  const invalidate = useInvalidateSales();
  return useMutation({
    mutationFn: ({ eventId, reason, idempotencyKey }: ReverseSaleVariables) =>
      api.post<unknown>(
        `/admin/events/${encodeURIComponent(eventId)}/reverse`,
        { reason },
        { idempotencyKey },
      ),
    // Not awaited, so the confirm dialog closes before the drawer re-renders with the new status.
    onSettled: () => {
      void invalidate();
    },
  });
}
