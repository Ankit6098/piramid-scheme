'use client';

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  EventReversalResultDto,
  RecordSaleInput,
  RecordSaleResultDto,
  SaleEventDetailDto,
  SaleProgramOptionDto,
} from '@app/shared';

import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

import { financeKeys } from '../finance/query-keys';
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

/**
 * Recording a sale creates rewards (auto-approved ones are posted to the ledger); reversing one
 * rejects or reverses them with compensating ledger entries. Refresh the sales feature and every
 * finance view those rewards appear in: approval queue + counts, ledger, reconciliation, the admin
 * overview counters, members' own rewards/earnings, the admin member detail and the audit log.
 */
function useInvalidateSales() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: eventKeys.all }),
      queryClient.invalidateQueries({ queryKey: financeKeys.adminRewards.all }),
      queryClient.invalidateQueries({ queryKey: financeKeys.ledger.all }),
      queryClient.invalidateQueries({ queryKey: financeKeys.reconciliation.all }),
      queryClient.invalidateQueries({ queryKey: financeKeys.adminOverview }),
      queryClient.invalidateQueries({ queryKey: queryKeys.rewards.all }),
      queryClient.invalidateQueries({ queryKey: financeKeys.adminMember }),
      queryClient.invalidateQueries({ queryKey: financeKeys.adminAudit }),
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
 * POST /admin/events/:id/reverse (`events:reverse`) — rejects every unposted reward of the sale and
 * reverses every posted one with a compensating ledger entry, in one transaction.
 */
export function useReverseSale() {
  const invalidate = useInvalidateSales();
  return useMutation({
    mutationFn: ({ eventId, reason, idempotencyKey }: ReverseSaleVariables) =>
      api.post<EventReversalResultDto>(
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

export interface RejectPendingSaleVariables {
  eventId: string;
  reason: string;
  /** Created once per dialog open. */
  idempotencyKey: string;
}

/**
 * POST /admin/events/:id/reject (`events:reverse`) — rejects a sale stuck in RECEIVED (it can never
 * be processed) so the same external id can be re-recorded as a new revision.
 */
export function useRejectPendingSale() {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateSales();
  return useMutation({
    mutationFn: ({ eventId, reason, idempotencyKey }: RejectPendingSaleVariables) =>
      api.post<SaleEventDetailDto>(`/admin/events/${encodeURIComponent(eventId)}/reject`, { reason }, { idempotencyKey }),
    onSuccess: (event) => {
      queryClient.setQueryData(eventKeys.detail(event.id), event);
    },
    onSettled: () => {
      void invalidate();
    },
  });
}
