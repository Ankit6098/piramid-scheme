import {
  MAX_TEAM_DEPTH,
  TREE_CHILDREN_LIMIT,
  type AdminDownlineMemberDto,
  type AdminTeamPathResponse,
  type AdminTeamSearchResultDto,
  type AdminTeamTreeResponse,
  type DownlineMemberDto,
  type TeamPathResponse,
  type TeamSearchResultDto,
  type TeamSummaryResponse,
  type TeamTreeResponse,
} from '@app/shared';

import { api } from '@/lib/api-client';

import { hierarchyKeys } from './query-keys';
import type { HierarchySource } from './types';

/** The signed-in member's own team (`/users/me/hierarchy/*`, depth ≤ 10, display names only). */
export const memberHierarchySource: HierarchySource = {
  key: hierarchyKeys.me(),
  maxDepth: MAX_TEAM_DEPTH,
  admin: false,
  tree: (rootId, depth, signal) =>
    api.get<TeamTreeResponse>('/users/me/hierarchy/tree', { query: { rootId, depth }, signal }),
  children: (parentId, cursor, signal) =>
    api.getPage<DownlineMemberDto>('/users/me/hierarchy/children', {
      query: { parentId, cursor, limit: TREE_CHILDREN_LIMIT },
      signal,
    }),
  path: (memberId, signal) => api.get<TeamPathResponse>(`/users/me/hierarchy/path/${memberId}`, { signal }),
  search: (q, signal) =>
    api.getPage<TeamSearchResultDto>('/users/me/hierarchy/search', { query: { q, limit: 20 }, signal }),
  summary: (signal) => api.get<TeamSummaryResponse>('/users/me/hierarchy/summary', { signal }),
};

/** Admin view of one member's network (`/admin/members/:id/hierarchy/*`, full names when in scope). */
export function adminHierarchySource(memberId: string): HierarchySource {
  const base = `/admin/members/${memberId}`;
  return {
    key: hierarchyKeys.admin(memberId),
    maxDepth: null,
    admin: true,
    anchorId: memberId,
    tree: (rootId, depth, signal) =>
      api.get<AdminTeamTreeResponse>(`${base}/hierarchy`, { query: { rootId, depth }, signal }),
    children: (parentId, cursor, signal) =>
      api.getPage<AdminDownlineMemberDto>(`${base}/hierarchy/children`, {
        query: { parentId, cursor, limit: TREE_CHILDREN_LIMIT },
        signal,
      }),
    path: (targetId, signal) => api.get<AdminTeamPathResponse>(`${base}/hierarchy/path/${targetId}`, { signal }),
    search: (q, signal) =>
      api.getPage<AdminTeamSearchResultDto>(`${base}/hierarchy/search`, { query: { q, limit: 20 }, signal }),
    summary: (signal) => api.get<TeamSummaryResponse>(`${base}/hierarchy/summary`, { signal }),
  };
}
