'use client';

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdminMemberDetailDto,
  AdminMemberRolesResultDto,
  AdminMemberStatusResultDto,
  RoleKey,
} from '@app/shared';

import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

export const ADMIN_MEMBERS_PATH = '/admin/members';

export interface MemberListFilters {
  q?: string;
  status?: string;
  role?: string;
  programId?: string;
}

export function adminMemberQueryOptions(id: string) {
  return queryOptions({
    queryKey: queryKeys.admin.member(id),
    queryFn: ({ signal }) => api.get<AdminMemberDetailDto>(`${ADMIN_MEMBERS_PATH}/${id}`, { signal }),
  });
}

/** `GET /admin/members/:id` — shared by the member layout (header) and the overview tab. */
export function useAdminMember(id: string | undefined) {
  return useQuery({ ...adminMemberQueryOptions(id ?? ''), enabled: Boolean(id) });
}

function useInvalidateMember(id: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.member(id) }),
      queryClient.invalidateQueries({ queryKey: ['admin', 'members'] }),
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.overview() }),
      queryClient.invalidateQueries({ queryKey: ['admin', 'audit'] }),
    ]);
}

export function useChangeMemberStatus(id: string) {
  const invalidate = useInvalidateMember(id);
  return useMutation({
    mutationFn: ({ action, reason }: { action: 'suspend' | 'reactivate'; reason: string }) =>
      api.post<AdminMemberStatusResultDto>(`${ADMIN_MEMBERS_PATH}/${id}/${action}`, { reason }),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateMemberRoles(id: string) {
  const invalidate = useInvalidateMember(id);
  return useMutation({
    mutationFn: (input: { roles: RoleKey[]; reason: string }) =>
      api.put<AdminMemberRolesResultDto>(`${ADMIN_MEMBERS_PATH}/${id}/roles`, input),
    onSuccess: () => invalidate(),
  });
}
