import type {
  AdminDownlineMemberDto,
  ApiPage,
  DownlineMemberDto,
  TeamSummaryResponse,
} from '@app/shared';

/** A member node from either the member API or the admin API (admin adds full name/status/scope). */
export type AnyMemberDto = DownlineMemberDto &
  Partial<Pick<AdminDownlineMemberDto, 'fullName' | 'status' | 'inScope'>>;

export interface AnyTreeNodeDto extends AnyMemberDto {
  children: AnyTreeNodeDto[];
  childrenLoaded: boolean;
  hasMoreChildren: boolean;
  childrenCursor: string | null;
}

export interface AnyTreeResponse {
  root: AnyTreeNodeDto;
  maxDepth: number | null;
  truncated: boolean;
}

export interface AnyPathNode {
  id: string;
  displayName: string;
  depth: number;
  fullName?: string | null;
}

export interface AnySearchResult {
  id: string;
  displayName: string;
  depth: number;
  statusBucket: DownlineMemberDto['statusBucket'];
  fullName?: string | null;
}

/**
 * Where the explorer gets its data: the signed-in member's own team, or an admin view of a member.
 * D3 only lays out what these endpoints return.
 */
export interface HierarchySource {
  /** Query-key prefix for everything this source loads. */
  key: readonly unknown[];
  /** Depth limit relative to the anchor (null = unlimited). */
  maxDepth: number | null;
  /** Admin view (full names, status, links to member pages). */
  admin: boolean;
  /** The anchor member (admin views); the member's own id is not needed. */
  anchorId?: string;
  tree(rootId: string | undefined, depth: number, signal?: AbortSignal): Promise<AnyTreeResponse>;
  children(parentId: string, cursor: string | null, signal?: AbortSignal): Promise<ApiPage<AnyMemberDto>>;
  path(memberId: string, signal?: AbortSignal): Promise<{ nodes: AnyPathNode[] }>;
  search(q: string, signal?: AbortSignal): Promise<ApiPage<AnySearchResult>>;
  summary(signal?: AbortSignal): Promise<TeamSummaryResponse>;
}
