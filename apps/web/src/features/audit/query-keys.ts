import type { ListParams } from '@/lib/query-keys';

/** Audit query keys, rooted under `['admin', 'audit']` (member mutations invalidate that root). */
export const auditKeys = {
  all: ['admin', 'audit'] as const,
  list: (params: ListParams) => ['admin', 'audit', 'list', params] as const,
  entry: (id: string) => ['admin', 'audit', 'entry', id] as const,
};
