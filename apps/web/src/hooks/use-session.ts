'use client';

/**
 * Session state for client components. `GET /api/v1/auth/session` → `{ data: { user } }`, 401 when
 * signed out (mapped to `user: null`, status "unauthenticated").
 *
 * UI permission checks are UX only — the API authorizes every request.
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Permission, RoleKey } from '@app/shared';

import { routes } from '@/config/routes';
import { api, getErrorMessage, isApiError, resetCsrfToken } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import type { SessionResponse, SessionUser } from '@/lib/types';

export type SessionStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'error';

async function fetchSession({ signal }: { signal?: AbortSignal }): Promise<SessionUser | null> {
  try {
    const res = await api.get<SessionResponse | null>('/auth/session', { signal });
    return res?.user ?? null;
  } catch (error) {
    if (isApiError(error) && error.isUnauthenticated) return null;
    throw error;
  }
}

export function sessionQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.session.current(),
    queryFn: fetchSession,
    staleTime: 60_000,
  });
}

export interface SessionState {
  user: SessionUser | null;
  status: SessionStatus;
  isLoading: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
  /** User holds `permission`. */
  can: (permission: Permission) => boolean;
  /** User holds at least one of `permissions` (true for an empty list). */
  canAny: (permissions: readonly Permission[]) => boolean;
  /** User holds every one of `permissions`. */
  canAll: (permissions: readonly Permission[]) => boolean;
  hasRole: (role: RoleKey) => boolean;
}

export function useSession(): SessionState {
  const query = useQuery(sessionQueryOptions());
  const user = query.data ?? null;
  const status: SessionStatus = query.isPending
    ? 'loading'
    : query.data === undefined && query.isError
      ? 'error'
      : user
        ? 'authenticated'
        : 'unauthenticated';
  const permissions: readonly string[] = user?.permissions ?? [];

  return {
    user,
    status,
    isLoading: query.isPending,
    error: query.error,
    refetch: query.refetch,
    can: (permission) => permissions.includes(permission),
    canAny: (list) => list.length === 0 || list.some((p) => permissions.includes(p)),
    canAll: (list) => list.every((p) => permissions.includes(p)),
    hasRole: (role) => user?.roles.includes(role) ?? false,
  };
}

/**
 * Signs out (`POST /api/v1/auth/logout`), wipes all cached data and hard-navigates to /login so no
 * state from the previous user survives (Cache Components keep hidden routes mounted otherwise).
 */
export function useLogout() {
  const queryClient = useQueryClient();
  const finishLogout = () => {
    queryClient.clear();
    resetCsrfToken();
    window.location.assign(routes.auth.login);
  };
  return useMutation({
    mutationFn: () => api.post('/auth/logout'),
    onSuccess: finishLogout,
    onError: (error) => {
      if (isApiError(error) && error.isUnauthenticated) return finishLogout();
      toast.error("Couldn't sign out", { description: getErrorMessage(error) });
    },
  });
}
