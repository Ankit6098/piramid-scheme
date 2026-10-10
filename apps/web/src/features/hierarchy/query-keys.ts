/**
 * Query keys of the team-tree feature. Member keys live under the `referrals` root and admin keys
 * under `admin › member › <id>`, so invalidating `queryKeys.referrals.all` / `queryKeys.admin.member(id)`
 * also refreshes the tree.
 */
export const hierarchyKeys = {
  me: () => ['referrals', 'hierarchy'] as const,
  admin: (memberId: string) => ['admin', 'member', memberId, 'hierarchy'] as const,
  summary: (base: readonly unknown[]) => [...base, 'summary'] as const,
  tree: (base: readonly unknown[], rootId: string | null, depth: number) => [...base, 'tree', rootId, depth] as const,
  children: (base: readonly unknown[], parentId: string, cursor: string | null) =>
    [...base, 'children', parentId, cursor] as const,
  path: (base: readonly unknown[], memberId: string) => [...base, 'path', memberId] as const,
  search: (base: readonly unknown[], q: string) => [...base, 'search', q] as const,
  ancestors: (memberId: string) => ['admin', 'member', memberId, 'ancestors'] as const,
  correctionPreview: (memberId: string, newSponsorId: string) =>
    ['admin', 'member', memberId, 'sponsor-correction', newSponsorId] as const,
};
