'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateFlagInput, FlagDto, FlagStatus, ResolveFlagInput } from '@app/shared';

import { useCursorList } from '@/components/app/data-table';
import { api, isApiError } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

export interface FlagFilters {
  status?: FlagStatus;
  kind?: string;
  userId?: string;
}

/** Suspicious-activity flags, newest first (`flags:manage`). */
export function useFlags(filters: FlagFilters) {
  return useCursorList<FlagDto>({
    queryKey: queryKeys.admin.flags({ ...filters }),
    path: '/admin/flags',
    query: { status: filters.status, kind: filters.kind, userId: filters.userId },
    pageSize: 25,
  });
}

/**
 * After a flag change: open-flag counts appear on the admin overview, member lists/details and
 * team views, so refresh the whole admin area (not only the flags list).
 */
function useInvalidateFlags() {
  const queryClient = useQueryClient();
  return {
    all: () => queryClient.invalidateQueries({ queryKey: queryKeys.admin.all }),
    /** 409 (e.g. the flag was already resolved by someone else): reload the list. */
    onConflict: (error: unknown) => {
      if (isApiError(error) && error.isConflict) {
        void queryClient.invalidateQueries({ queryKey: ['admin', 'flags'] });
      }
    },
  };
}

export function useRaiseFlag() {
  const invalidate = useInvalidateFlags();
  return useMutation({
    mutationFn: (input: CreateFlagInput) => api.post<FlagDto>('/admin/flags', input),
    onSuccess: () => invalidate.all(),
    onError: invalidate.onConflict,
  });
}

export function useResolveFlag() {
  const invalidate = useInvalidateFlags();
  return useMutation({
    mutationFn: ({ id, ...input }: ResolveFlagInput & { id: string }) =>
      api.post<FlagDto>(`/admin/flags/${id}/resolve`, input),
    onSuccess: () => invalidate.all(),
    onError: invalidate.onConflict,
  });
}
