'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateFlagInput, FlagDto, FlagStatus, ResolveFlagInput } from '@app/shared';

import { useCursorList } from '@/components/app/data-table';
import { api } from '@/lib/api-client';
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

function useInvalidateFlags() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['admin', 'flags'] });
}

export function useRaiseFlag() {
  const invalidate = useInvalidateFlags();
  return useMutation({
    mutationFn: (input: CreateFlagInput) => api.post<FlagDto>('/admin/flags', input),
    onSuccess: () => invalidate(),
  });
}

export function useResolveFlag() {
  const invalidate = useInvalidateFlags();
  return useMutation({
    mutationFn: ({ id, ...input }: ResolveFlagInput & { id: string }) =>
      api.post<FlagDto>(`/admin/flags/${id}/resolve`, input),
    onSuccess: () => invalidate(),
  });
}
