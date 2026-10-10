'use client';

/**
 * Data hooks for rewards: member history + earnings (`/users/me/*`) and the admin approval queue
 * (`/admin/rewards/*`, `/admin/events/:id/reverse`). Decisions send an Idempotency-Key created once
 * per user intent by the caller.
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdminRewardCountsDto,
  AdminRewardDetailDto,
  AdminRewardFacetsDto,
  BulkApproveResultDto,
  EventReversalResultDto,
  MemberEarningsDto,
  MemberRewardFacetsDto,
  RewardDecisionResultDto,
} from '@app/shared';

import { api } from '@/lib/api-client';
import type { ListParams } from '@/lib/query-keys';

import { financeKeys } from '../finance/query-keys';

// ─── Member ──────────────────────────────────────────────────────────────────

export function earningsQueryOptions() {
  return queryOptions({
    queryKey: financeKeys.member.earnings(),
    queryFn: ({ signal }) => api.get<MemberEarningsDto>('/users/me/earnings', { signal }),
  });
}

export function useEarnings() {
  return useQuery(earningsQueryOptions());
}

export function useMyRewardFacets() {
  return useQuery({
    queryKey: financeKeys.member.facets(),
    queryFn: ({ signal }) => api.get<MemberRewardFacetsDto>('/users/me/rewards/facets', { signal }),
    staleTime: 5 * 60_000,
  });
}

// ─── Admin ───────────────────────────────────────────────────────────────────

export function useAdminRewardCounts(params: ListParams) {
  return useQuery({
    queryKey: financeKeys.adminRewards.counts(params),
    queryFn: ({ signal }) =>
      api.get<AdminRewardCountsDto>('/admin/rewards/counts', { query: params as Record<string, string>, signal }),
  });
}

export function useAdminRewardFacets() {
  return useQuery({
    queryKey: financeKeys.adminRewards.facets(),
    queryFn: ({ signal }) => api.get<AdminRewardFacetsDto>('/admin/rewards/facets', { signal }),
    staleTime: 5 * 60_000,
  });
}

export function useAdminReward(id: string | undefined) {
  return useQuery({
    queryKey: financeKeys.adminRewards.detail(id ?? 'none'),
    queryFn: ({ signal }) => api.get<AdminRewardDetailDto>(`/admin/rewards/${encodeURIComponent(id!)}`, { signal }),
    enabled: Boolean(id),
  });
}

/** Everything a reward decision can change: queue, counts, details, ledger, reconciliation, sales. */
function useInvalidateFinance() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: financeKeys.adminRewards.all }),
      queryClient.invalidateQueries({ queryKey: financeKeys.ledger.all }),
      queryClient.invalidateQueries({ queryKey: financeKeys.reconciliation.all }),
      queryClient.invalidateQueries({ queryKey: financeKeys.adminOverview }),
      queryClient.invalidateQueries({ queryKey: financeKeys.events }),
    ]);
}

export function useApproveReward() {
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: ({ id, idempotencyKey }: { id: string; idempotencyKey: string }) =>
      api.post<RewardDecisionResultDto>(`/admin/rewards/${encodeURIComponent(id)}/approve`, undefined, { idempotencyKey }),
    onSettled: () => invalidate(),
  });
}

export function useRejectReward() {
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: ({ id, reason, idempotencyKey }: { id: string; reason: string; idempotencyKey: string }) =>
      api.post<RewardDecisionResultDto>(`/admin/rewards/${encodeURIComponent(id)}/reject`, { reason }, { idempotencyKey }),
    onSettled: () => invalidate(),
  });
}

export function useReverseReward() {
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: ({ id, reason, idempotencyKey }: { id: string; reason: string; idempotencyKey: string }) =>
      api.post<RewardDecisionResultDto>(`/admin/rewards/${encodeURIComponent(id)}/reverse`, { reason }, { idempotencyKey }),
    onSettled: () => invalidate(),
  });
}

export function useBulkApproveRewards() {
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: ({ ids, idempotencyKey }: { ids: string[]; idempotencyKey: string }) =>
      api.post<BulkApproveResultDto>('/admin/rewards/bulk-approve', { ids }, { idempotencyKey }),
    onSettled: () => invalidate(),
  });
}

export function useReverseEvent() {
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: ({ eventId, reason, idempotencyKey }: { eventId: string; reason: string; idempotencyKey: string }) =>
      api.post<EventReversalResultDto>(`/admin/events/${encodeURIComponent(eventId)}/reverse`, { reason }, { idempotencyKey }),
    onSettled: () => invalidate(),
  });
}
