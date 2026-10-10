'use client';

import { useQuery } from '@tanstack/react-query';
import type { LedgerSummaryDto, LedgerTransactionDetailDto } from '@app/shared';

import { api } from '@/lib/api-client';

import { financeKeys } from '../finance/query-keys';

export function useLedgerSummary() {
  return useQuery({
    queryKey: financeKeys.ledger.summary(),
    queryFn: ({ signal }) => api.get<LedgerSummaryDto>('/admin/ledger/summary', { signal }),
  });
}

export function useLedgerTransaction(id: string | undefined) {
  return useQuery({
    queryKey: financeKeys.ledger.transaction(id ?? 'none'),
    queryFn: ({ signal }) => api.get<LedgerTransactionDetailDto>(`/admin/ledger/transactions/${encodeURIComponent(id!)}`, { signal }),
    enabled: Boolean(id),
  });
}
