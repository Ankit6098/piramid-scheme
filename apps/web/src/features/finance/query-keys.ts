/**
 * TanStack Query keys for the finance features (rewards, ledger, reconciliation). Roots match the
 * central factory (`queryKeys.rewards.all = ['rewards']`, `queryKeys.admin.all = ['admin']`) so a
 * broad invalidation from another feature still reaches these queries.
 */
import type { ListParams } from '@/lib/query-keys';

export const financeKeys = {
  /** Member: own rewards and earnings (root shared with `queryKeys.rewards`). */
  member: {
    all: ['rewards'] as const,
    /** Same key as `queryKeys.rewards.summary()` — the earnings buckets. */
    earnings: () => ['rewards', 'summary'] as const,
    list: (params: ListParams) => ['rewards', 'list', params] as const,
    detail: (id: string) => ['rewards', 'detail', id] as const,
    facets: () => ['rewards', 'facets'] as const,
  },
  /** Admin approval queue. */
  adminRewards: {
    all: ['admin', 'rewards'] as const,
    list: (params: ListParams) => ['admin', 'rewards', 'list', params] as const,
    counts: (params: ListParams) => ['admin', 'rewards', 'counts', params] as const,
    facets: () => ['admin', 'rewards', 'facets'] as const,
    detail: (id: string) => ['admin', 'rewards', 'detail', id] as const,
  },
  ledger: {
    all: ['admin', 'ledger'] as const,
    summary: () => ['admin', 'ledger', 'summary'] as const,
    transactions: (params: ListParams) => ['admin', 'ledger', 'transactions', params] as const,
    transaction: (id: string) => ['admin', 'ledger', 'transaction', id] as const,
    accounts: (params: ListParams) => ['admin', 'ledger', 'accounts', params] as const,
  },
  reconciliation: {
    all: ['admin', 'reconciliation'] as const,
    report: () => ['admin', 'reconciliation', 'report'] as const,
  },
  /** Admin overview counters (pending approvals, exceptions) — owned by the admin feature. */
  adminOverview: ['admin', 'overview'] as const,
  /** Sales events feature root (event detail shows reward states). */
  events: ['events'] as const,
};
