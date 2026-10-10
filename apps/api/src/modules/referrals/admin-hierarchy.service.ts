import { Injectable } from '@nestjs/common';
import type {
  AdminAncestorsResponse,
  AdminDownlineMemberDto,
  AdminTeamNodeDto,
  AdminTeamPathResponse,
  AdminTeamSearchResultDto,
  AdminTeamTreeResponse,
  ApiPage,
  HierarchyChildrenQuery,
  HierarchySearchQuery,
  HierarchyTreeQuery,
  TeamSummaryResponse,
} from '@app/shared';
import { z } from 'zod';
import type { AuthContext } from '../../common/auth/auth-context';
import { programScopeFilter } from '../../common/auth/program-access';
import { notFound } from '../../common/errors/app-error';
import { decodeCursor, paginate } from '../../common/pagination/cursor';
import { PrismaService } from '../../common/prisma/prisma.service';
import { nameSearchPatterns, statusBucketOf, toDisplayName } from './domain/display-name';
import { visibleChildCount } from './domain/tree-plan';
import { summaryFrom } from './team.mappers';
import { decodeChildCursor, TeamTreeBuilder, type BuiltTreeNode } from './team-tree.builder';
import { TeamRepository, type TeamNodeRow } from './team.repository';

/** Which members an admin may read in full (business rules §3). */
type MemberScope = { kind: 'all' } | { kind: 'programs'; programIds: string[] };

const searchCursorSchema = z.object({ d: z.number().int().min(1), id: z.uuid() });

/**
 * Admin views of the referral tree (`members:read`). SUPER_ADMIN and FINANCE_REVIEWER read every
 * member; a PROGRAM_ADMIN may open only members enrolled in one of their assigned programs (others
 * are 404), and sees
 * other members of that tree with the privacy-filtered display name only (`fullName: null`,
 * `inScope: false`). Admin trees have no depth limit (still lazily loaded and node-bounded).
 */
@Injectable()
export class AdminHierarchyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: TeamRepository,
    private readonly trees: TeamTreeBuilder,
  ) {}

  async getTree(auth: AuthContext, memberId: string, q: HierarchyTreeQuery): Promise<AdminTeamTreeResponse> {
    const scope = await this.assertMemberReadable(auth, memberId);
    const rootId = q.rootId ?? memberId;
    const rootDepth = await this.depthInSubtree(memberId, rootId);
    const rootRow = await this.repo.node(this.prisma, rootId);
    if (!rootRow) throw notFound('Member');
    const built = await this.trees.build(this.prisma, { root: rootRow, rootDepth, levels: q.depth, maxDepth: null });
    const inScope = await this.inScopeSet(scope, built.ids);
    return { root: toAdminNode(built.root, inScope), maxDepth: null, truncated: built.truncated };
  }

  async getChildren(
    auth: AuthContext,
    memberId: string,
    q: HierarchyChildrenQuery,
  ): Promise<ApiPage<AdminDownlineMemberDto>> {
    const scope = await this.assertMemberReadable(auth, memberId);
    const parentDepth = await this.depthInSubtree(memberId, q.parentId);
    const after = decodeChildCursor(q.cursor);
    const rows = await this.repo.childrenPage(this.prisma, q.parentId, after, q.limit);
    const inScope = await this.inScopeSet(scope, rows.slice(0, q.limit).map((r) => r.id));
    return paginate(
      rows,
      q.limit,
      (r) => ({ at: r.attributedAt.toISOString(), id: r.id }),
      (r) => toAdminFlatNode(r, parentDepth + 1, inScope.has(r.id)),
    );
  }

  async getSummary(auth: AuthContext, memberId: string): Promise<TeamSummaryResponse> {
    await this.assertMemberReadable(auth, memberId);
    return summaryFrom(await this.repo.depthCounts(this.prisma, memberId, null), null);
  }

  async getPath(auth: AuthContext, memberId: string, targetId: string): Promise<AdminTeamPathResponse> {
    const scope = await this.assertMemberReadable(auth, memberId);
    const depth = await this.depthInSubtree(memberId, targetId);
    const rows = await this.repo.pathUp(this.prisma, targetId, depth);
    const inScope = await this.inScopeSet(scope, rows.map((r) => r.id));
    return {
      nodes: rows
        .map((r) => ({
          id: r.id,
          displayName: toDisplayName(r.fullName),
          fullName: inScope.has(r.id) ? r.fullName : null,
          depth: depth - r.up,
        }))
        .sort((a, b) => a.depth - b.depth),
    };
  }

  /** Full-name search in the member's subtree; a PROGRAM_ADMIN only finds members in scope. */
  async search(auth: AuthContext, memberId: string, q: HierarchySearchQuery): Promise<ApiPage<AdminTeamSearchResultDto>> {
    const scope = await this.assertMemberReadable(auth, memberId);
    const after = decodeCursor(q.cursor, searchCursorSchema);
    const { pattern } = nameSearchPatterns(q.q);
    const rows = await this.repo.search(this.prisma, {
      ancestorId: memberId,
      maxDepth: null,
      pattern,
      prefilter: null,
      matchFullName: true,
      programIds: scope.kind === 'programs' ? scope.programIds : null,
      ...(after ? { after: { depth: after.d, id: after.id } } : {}),
      limit: q.limit,
    });
    return paginate(rows, q.limit, (r) => ({ d: r.depth, id: r.id }), (r) => ({
      id: r.id,
      displayName: toDisplayName(r.fullName),
      fullName: r.fullName,
      depth: r.depth,
      statusBucket: statusBucketOf(r.status),
    }));
  }

  async getAncestors(auth: AuthContext, memberId: string): Promise<AdminAncestorsResponse> {
    const scope = await this.assertMemberReadable(auth, memberId);
    const [rows, rel] = await Promise.all([
      this.repo.ancestors(this.prisma, memberId, null),
      this.prisma.referralRelationship.findUnique({
        where: { childUserId: memberId },
        select: { source: true, attributedAt: true },
      }),
    ]);
    const inScope = await this.inScopeSet(scope, rows.map((r) => r.id));
    return {
      memberId,
      ancestors: rows.map((r) => {
        const visible = inScope.has(r.id);
        return {
          id: r.id,
          displayName: toDisplayName(r.fullName),
          fullName: visible ? r.fullName : null,
          status: visible ? r.status : null,
          inScope: visible,
          depth: r.depth,
          joinedAt: r.joinedAt.toISOString(),
        };
      }),
      attributionSource: rel?.source ?? null,
      attributedAt: rel?.attributedAt.toISOString() ?? null,
    };
  }

  // ─── scoping ───────────────────────────────────────────────────────────

  /**
   * 404 when the member does not exist or — for a PROGRAM_ADMIN — is not enrolled in any of their
   * programs. Returns the caller's read scope for node-level filtering.
   */
  async assertMemberReadable(auth: AuthContext, memberId: string): Promise<MemberScope> {
    const exists = await this.prisma.user.findUnique({ where: { id: memberId }, select: { id: true } });
    if (!exists) throw notFound('Member');
    const filter = programScopeFilter(auth, 'read');
    if (filter === 'ALL') return { kind: 'all' };
    const scope: MemberScope = { kind: 'programs', programIds: filter };
    const enrolled = await this.repo.enrolledIn(this.prisma, [memberId], filter);
    // Outside a PROGRAM_ADMIN's scope a member behaves as missing (same as the members API).
    if (!enrolled.has(memberId)) throw notFound('Member');
    return scope;
  }

  private async inScopeSet(scope: MemberScope, ids: readonly string[]): Promise<Set<string>> {
    if (scope.kind === 'all') return new Set(ids);
    return this.repo.enrolledIn(this.prisma, ids, scope.programIds);
  }

  /** Depth of `targetId` below `memberId` (0 = same); 404 when outside the member's subtree. */
  private async depthInSubtree(memberId: string, targetId: string): Promise<number> {
    if (targetId === memberId) return 0;
    const depth = await this.repo.depthBetween(this.prisma, memberId, targetId);
    if (depth === null) throw notFound('Member');
    return depth;
  }
}

function toAdminFlatNode(row: TeamNodeRow, depth: number, inScope: boolean): AdminDownlineMemberDto {
  return {
    id: row.id,
    displayName: toDisplayName(row.fullName),
    fullName: inScope ? row.fullName : null,
    status: inScope ? row.status : null,
    inScope,
    depth,
    joinedAt: row.joinedAt.toISOString(),
    statusBucket: statusBucketOf(row.status),
    hasEligibleEnrollment: row.hasEligible,
    childCount: visibleChildCount(depth, row.childCount, null),
  };
}

function toAdminNode(node: BuiltTreeNode, inScope: ReadonlySet<string>): AdminTeamNodeDto {
  return {
    ...toAdminFlatNode(node.row, node.depth, inScope.has(node.row.id)),
    childCount: node.childCount,
    children: node.children.map((c) => toAdminNode(c, inScope)),
    childrenLoaded: node.childrenLoaded,
    hasMoreChildren: node.hasMoreChildren,
    childrenCursor: node.childrenCursor,
  };
}
