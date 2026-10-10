'use client';

/** Self-service account API (`/api/v1/users/me/*`). */
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AcceptedResponseDto,
  ActivityEntryDto,
  ChangePasswordRequest,
  ConfirmEmailChangeRequest,
  ProfileDto,
  RevokeSessionResponseDto,
  RevokeSessionsResponseDto,
  StartEmailChangeRequest,
  UpdateProfileRequest,
  UserSessionDto,
} from '@app/shared';

import { useCursorList } from '@/components/app/data-table';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

import { profileKeys } from './query-keys';

export function profileQueryOptions() {
  return queryOptions({
    queryKey: profileKeys.me(),
    queryFn: ({ signal }) => api.get<ProfileDto>('/users/me', { signal }),
  });
}

export function useProfile() {
  return useQuery(profileQueryOptions());
}

/** Writes a fresh profile into the cache and refreshes the session (name/avatar/email in the shell). */
function useProfileUpdated() {
  const queryClient = useQueryClient();
  return (profile: ProfileDto) => {
    queryClient.setQueryData(profileKeys.me(), profile);
    void queryClient.invalidateQueries({ queryKey: queryKeys.session.all });
    void queryClient.invalidateQueries({ queryKey: profileKeys.activity() });
  };
}

export function useUpdateProfile() {
  const updated = useProfileUpdated();
  return useMutation({
    mutationFn: (body: UpdateProfileRequest) => api.patch<ProfileDto>('/users/me', body),
    onSuccess: updated,
  });
}

export function useChangePassword() {
  const updated = useProfileUpdated();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ChangePasswordRequest) => api.post<ProfileDto>('/users/me/password', body),
    onSuccess: (profile) => {
      updated(profile);
      void queryClient.invalidateQueries({ queryKey: profileKeys.sessions() });
    },
  });
}

export function useStartEmailChange() {
  return useMutation({
    mutationFn: (body: StartEmailChangeRequest) =>
      api.post<AcceptedResponseDto>('/users/me/email-change', body),
  });
}

export function useConfirmEmailChange() {
  const updated = useProfileUpdated();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ConfirmEmailChangeRequest) =>
      api.post<ProfileDto>('/users/me/email-change/confirm', body),
    onSuccess: (profile) => {
      updated(profile);
      void queryClient.invalidateQueries({ queryKey: profileKeys.sessions() });
    },
  });
}

export function useSessionsList() {
  return useCursorList<UserSessionDto>({
    queryKey: profileKeys.sessions(),
    path: '/users/me/sessions',
    pageSize: 10,
  });
}

export function useRevokeSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<RevokeSessionResponseDto>(`/users/me/sessions/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: profileKeys.sessions() });
      void queryClient.invalidateQueries({ queryKey: profileKeys.activity() });
    },
  });
}

export function useRevokeOtherSessions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<RevokeSessionsResponseDto>('/users/me/sessions/revoke-others'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: profileKeys.sessions() });
      void queryClient.invalidateQueries({ queryKey: profileKeys.activity() });
    },
  });
}

export function useActivityList() {
  return useCursorList<ActivityEntryDto>({
    queryKey: profileKeys.activity(),
    path: '/users/me/activity',
    pageSize: 25,
  });
}

export function useResetTotp() {
  const updated = useProfileUpdated();
  return useMutation({
    mutationFn: (code: string) => api.post<ProfileDto>('/users/me/mfa/totp/reset', { code }),
    onSuccess: updated,
  });
}
