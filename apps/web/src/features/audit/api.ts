'use client';

import { queryOptions, useQuery } from '@tanstack/react-query';
import type { AuditLogDetailDto } from '@app/shared';

import { api } from '@/lib/api-client';

import { auditKeys } from './query-keys';

export const AUDIT_PATH = '/admin/audit';

export function auditEntryQueryOptions(id: string) {
  return queryOptions({
    queryKey: auditKeys.entry(id),
    queryFn: ({ signal }) => api.get<AuditLogDetailDto>(`${AUDIT_PATH}/${id}`, { signal }),
    staleTime: Infinity, // audit entries are append-only
  });
}

export function useAuditEntry(id: string | null) {
  return useQuery({ ...auditEntryQueryOptions(id ?? ''), enabled: Boolean(id) });
}
