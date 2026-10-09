import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';

import { isApiError } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

/** Don't retry client errors (4xx) — they won't fix themselves. Retry network/5xx twice. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

/**
 * Creates the app's QueryClient. When any request comes back 401 (session expired/revoked) or
 * MFA_REQUIRED, the session query is invalidated so `<RequireAuth>` can redirect.
 */
export function makeQueryClient(): QueryClient {
  let client: QueryClient | undefined = undefined;

  const onAuthError = (error: unknown, key?: readonly unknown[]) => {
    if (!client || !isApiError(error)) return;
    if (key && key[0] === queryKeys.session.all[0]) return;
    if (error.isUnauthenticated || error.isMfaRequired) {
      void client.invalidateQueries({ queryKey: queryKeys.session.all });
    }
  };

  client = new QueryClient({
    queryCache: new QueryCache({ onError: (error, query) => onAuthError(error, query.queryKey) }),
    mutationCache: new MutationCache({ onError: (error) => onAuthError(error) }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: shouldRetry,
        refetchOnWindowFocus: true,
      },
      mutations: {
        retry: false,
      },
    },
  });
  return client;
}
