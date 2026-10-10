'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReconciliationReportDto } from '@app/shared';

import { api } from '@/lib/api-client';

import { financeKeys } from '../finance/query-keys';

export function useReconciliationReport() {
  return useQuery({
    queryKey: financeKeys.reconciliation.report(),
    queryFn: ({ signal }) => api.get<ReconciliationReportDto>('/admin/reconciliation', { signal }),
    staleTime: 60_000,
  });
}

/** Re-runs every check now (bypasses the ~60 s server cache). */
export function useRefreshReconciliation() {
  const queryClient = useQueryClient();
  return async () => {
    const report = await api.get<ReconciliationReportDto>('/admin/reconciliation', { query: { refresh: 'true' } });
    queryClient.setQueryData(financeKeys.reconciliation.report(), report);
    return report;
  };
}
