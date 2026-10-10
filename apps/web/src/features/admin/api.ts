'use client';

import { queryOptions, useQuery } from '@tanstack/react-query';
import type { AdminOverviewDto } from '@app/shared';

import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

export function adminOverviewQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.admin.overview(),
    queryFn: ({ signal }) => api.get<AdminOverviewDto>('/admin/overview', { signal }),
    staleTime: 60_000,
  });
}

/** `GET /admin/overview` — aggregates scoped to the caller (program-scoped for PROGRAM_ADMIN). */
export function useAdminOverview() {
  return useQuery(adminOverviewQueryOptions());
}
