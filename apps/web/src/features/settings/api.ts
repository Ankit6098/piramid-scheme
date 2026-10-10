'use client';

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CurrencyDto, PlatformSettingsDto, UpdatePlatformSettingsInput } from '@app/shared';

import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

import { settingsKeys } from './query-keys';

export function adminSettingsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.settings.admin(),
    queryFn: ({ signal }) => api.get<PlatformSettingsDto>('/admin/settings', { signal }),
    // The form re-mounts on a new version; don't swap values under an admin who is editing.
    refetchOnWindowFocus: false,
  });
}

/** Full platform settings (SUPER_ADMIN). */
export function useAdminSettings() {
  return useQuery(adminSettingsQueryOptions());
}

/** Supported currencies (reference data, rarely changes). */
export function useCurrencies() {
  return useQuery({
    queryKey: settingsKeys.currencies(),
    queryFn: ({ signal }) => api.get<CurrencyDto[]>('/admin/currencies', { signal }),
    staleTime: 60 * 60_000,
  });
}

/** PUT /admin/settings — refreshes the admin view and the public display format everywhere. */
export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdatePlatformSettingsInput) => api.put<PlatformSettingsDto>('/admin/settings', input),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.settings.admin(), data);
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.all });
    },
  });
}
