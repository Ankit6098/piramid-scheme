import { Injectable } from '@nestjs/common';
import {
  MAX_TEAM_DEPTH,
  type ApiPage,
  type DirectReferralDto,
  type DirectReferralsQuery,
  type DownlineMemberDto,
  type HierarchyChildrenQuery,
  type HierarchySearchQuery,
  type HierarchyTreeQuery,
  type MyParentResponse,
  type TeamPathResponse,
  type TeamSearchResultDto,
  type TeamSummaryResponse,
  type TeamTreeResponse,
} from '@app/shared';
import { z } from 'zod';
import { notFound } from '../../common/errors/app-error';
import { decodeCursor, paginate } from '../../common/pagination/cursor';
import { PrismaService } from '../../common/prisma/prisma.service';
import { nameSearchPatterns, statusBucketOf, toDisplayName } from './domain/display-name';
import { canSeeChildren } from './domain/tree-plan';
import { summaryFrom, toDownlineDto, toTeamNodeDto } from './team.mappers';
import { decodeChildCursor, TeamTreeBuilder } from './team-tree.builder';
import { TeamRepository } from './team.repository';

const searchCursorSchema = z.object({ d: z.number().int().min(1), id: z.uuid() });

/**
 * The signed-in member's own network (business rules §6): sponsor + upline, direct referrals and
 * the team tree — descendants up to depth 10 with privacy-filtered fields only (display name,
 * depth, joined date, status bucket, eligible-enrollment flag, visible direct-referral count).
 * Members outside the viewer's subtree, or deeper than 10 levels, are reported as "not found" —
 * never as forbidden — so ids cannot be probed. All reads are closure-table/index bounded.
 */
@Injectable()
export class TeamService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: TeamRepository,
    private readonly trees: TeamTreeBuilder,
  ) {}

  /** `GET /users/me/parent`: sponsor + upline (≤ 10 levels), or null for a root member. */
  async getParent(viewerId: string): Promise<MyParentResponse | null> {
    const rel = await this.prisma.referralRelationship.findUnique({
      where: { childUserId: viewerId },
      select: { attributedAt: true, source: true, sponsor: { select: { fullName: true, createdAt: true } } },
    });
    if (!rel) return null;
    const rows = await this.repo.ancestors(this.prisma, viewerId, MAX_TEAM_DEPTH + 1);
    return {
      sponsor: {
        displayName: toDisplayName(rel.sponsor.fullName),
        joinedAt: rel.sponsor.createdAt.toISOString(),
        attributedAt: rel.attributedAt.toISOString(),
        attributionSource: rel.source,
      },
      ancestors: rows.slice(0, MAX_TEAM_DEPTH).map((r) => ({
        displayName: toDisplayName(r.fullName),
        depth: r.depth,
        joinedAt: r.joinedAt.toISOString(),
      })),
      hasMoreAncestors: rows.length > MAX_TEAM_DEPTH,
    };
  }

  /** `GET /users/me/referrals`: direct referrals, newest first. */
  async listDirectReferrals(viewerId: string, q: DirectReferralsQuery): Promise<ApiPage<DirectReferralDto>> {
    const before = decodeChildCursor(q.cursor);
    const rows = await this.repo.directReferrals(this.prisma, viewerId, {
      ...(q.status ? { status: q.status } : {}),
      ...(before ? { before } : {}),
      limit: q.limit,
    });
    return paginate(
      rows,
      q.limit,
      (r) => ({ at: r.attributedAt.toISOString(), id: r.id }),
      (r) => ({ ...toDownlineDto(r, 1, MAX_TEAM_DEPTH), attributedAt: r.attributedAt.toISOString() }),
    );
  }

  /** `GET /users/me/hierarchy/summary` */
  async getSummary(viewerId: string): Promise<TeamSummaryResponse> {
    return summaryFrom(await this.repo.depthCounts(this.prisma, viewerId, MAX_TEAM_DEPTH), MAX_TEAM_DEPTH);
  }

  /** `GET /users/me/hierarchy/tree`: bounded subtree rooted at the viewer or a visible descendant. */
  async getTree(viewerId: string, q: HierarchyTreeQuery): Promise<TeamTreeResponse> {
    const rootId = q.rootId ?? viewerId;
    const rootDepth = await this.visibleDepth(viewerId, rootId);
    const rootRow = await this.repo.node(this.prisma, rootId);
    if (!rootRow) throw notFound('Member');
    const built = await this.trees.build(this.prisma, {
      root: rootRow,
      rootDepth,
      levels: q.depth,
      maxDepth: MAX_TEAM_DEPTH,
    });
    return { root: toTeamNodeDto(built.root), maxDepth: MAX_TEAM_DEPTH, truncated: built.truncated };
  }

  /** `GET /users/me/hierarchy/children`: next page of a visible node's children. */
  async getChildren(viewerId: string, q: HierarchyChildrenQuery): Promise<ApiPage<DownlineMemberDto>> {
    const parentDepth = await this.visibleDepth(viewerId, q.parentId);
    const after = decodeChildCursor(q.cursor);
    if (!canSeeChildren(parentDepth, MAX_TEAM_DEPTH)) return { data: [], page: { nextCursor: null, limit: q.limit } };
    const rows = await this.repo.childrenPage(this.prisma, q.parentId, after, q.limit);
    return paginate(
      rows,
      q.limit,
      (r) => ({ at: r.attributedAt.toISOString(), id: r.id }),
      (r) => toDownlineDto(r, parentDepth + 1, MAX_TEAM_DEPTH),
    );
  }

  /** `GET /users/me/hierarchy/path/:memberId`: breadcrumb from the viewer down to the member. */
  async getPath(viewerId: string, memberId: string): Promise<TeamPathResponse> {
    const depth = await this.visibleDepth(viewerId, memberId);
    const rows = await this.repo.pathUp(this.prisma, memberId, depth);
    return {
      nodes: rows
        .map((r) => ({ id: r.id, displayName: toDisplayName(r.fullName), depth: depth - r.up }))
        .sort((a, b) => a.depth - b.depth),
    };
  }

  /** `GET /users/me/hierarchy/search`: display-name search among the viewer's visible descendants. */
  async search(viewerId: string, q: HierarchySearchQuery): Promise<ApiPage<TeamSearchResultDto>> {
    const after = decodeCursor(q.cursor, searchCursorSchema);
    const { pattern, prefilter } = nameSearchPatterns(q.q);
    const rows = await this.repo.search(this.prisma, {
      ancestorId: viewerId,
      maxDepth: MAX_TEAM_DEPTH,
      pattern,
      prefilter,
      matchFullName: false,
      ...(after ? { after: { depth: after.d, id: after.id } } : {}),
      limit: q.limit,
    });
    return paginate(
      rows,
      q.limit,
      (r) => ({ d: r.depth, id: r.id }),
      (r) => ({
        id: r.id,
        displayName: toDisplayName(r.fullName),
        depth: r.depth,
        statusBucket: statusBucketOf(r.status),
      }),
    );
  }

  /** Depth of `memberId` below the viewer (0 = self); 404 unless within the visible depth. */
  private async visibleDepth(viewerId: string, memberId: string): Promise<number> {
    if (memberId === viewerId) return 0;
    const depth = await this.repo.depthBetween(this.prisma, viewerId, memberId);
    if (depth === null || depth < 1 || depth > MAX_TEAM_DEPTH) throw notFound('Member');
    return depth;
  }
}
