'use client';

import { queryOptions, useQuery } from '@tanstack/react-query';
import type { MemberDashboardDto } from '@app/shared';

import { api } from '@/lib/api-client';

import { dashboardKeys } from './query-keys';

export function memberDashboardQueryOptions() {
  return queryOptions({
    queryKey: dashboardKeys.me(),
    queryFn: ({ signal }) => api.get<MemberDashboardDto>('/users/me/dashboard', { signal }),
  });
}

/** `GET /users/me/dashboard` — the signed-in member's own summary. */
export function useMemberDashboard() {
  return useQuery(memberDashboardQueryOptions());
}
