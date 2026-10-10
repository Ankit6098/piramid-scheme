import type { DownlineMemberDto, TeamNodeDto, TeamSummaryResponse } from '@app/shared';
import { statusBucketOf, toDisplayName } from './domain/display-name';
import { visibleChildCount } from './domain/tree-plan';
import type { BuiltTreeNode } from './team-tree.builder';
import type { DepthCountRow, TeamNodeRow } from './team.repository';

// Explicit allow-list mappers for member-facing team DTOs (business rules §6).

export function toDownlineDto(row: TeamNodeRow, depth: number, maxDepth: number | null): DownlineMemberDto {
  return {
    id: row.id,
    displayName: toDisplayName(row.fullName),
    depth,
    joinedAt: row.joinedAt.toISOString(),
    statusBucket: statusBucketOf(row.status),
    hasEligibleEnrollment: row.hasEligible,
    childCount: visibleChildCount(depth, row.childCount, maxDepth),
  };
}

export function toTeamNodeDto(node: BuiltTreeNode): TeamNodeDto {
  return {
    id: node.row.id,
    displayName: toDisplayName(node.row.fullName),
    depth: node.depth,
    joinedAt: node.row.joinedAt.toISOString(),
    statusBucket: statusBucketOf(node.row.status),
    hasEligibleEnrollment: node.row.hasEligible,
    childCount: node.childCount,
    children: node.children.map(toTeamNodeDto),
    childrenLoaded: node.childrenLoaded,
    hasMoreChildren: node.hasMoreChildren,
    childrenCursor: node.childrenCursor,
  };
}

export function summaryFrom(rows: readonly DepthCountRow[], maxDepth: number | null): TeamSummaryResponse {
  let teamSize = 0;
  let active = 0;
  let eligible = 0;
  for (const r of rows) {
    teamSize += r.count;
    active += r.active;
    eligible += r.eligible;
  }
  return {
    directCount: rows.find((r) => r.depth === 1)?.count ?? 0,
    teamSize,
    countsByDepth: rows.map((r) => ({ depth: r.depth, count: r.count })),
    activeCount: active,
    inactiveCount: teamSize - active,
    withEligibleEnrollmentCount: eligible,
    maxDepth,
  };
}
