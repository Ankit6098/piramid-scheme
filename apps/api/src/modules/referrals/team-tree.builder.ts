import { Injectable } from '@nestjs/common';
import { MAX_TREE_RESPONSE_NODES, TREE_CHILDREN_LIMIT } from '@app/shared';
import { z } from 'zod';
import { decodeCursor, encodeCursor } from '../../common/pagination/cursor';
import type { Db } from '../../common/prisma/prisma.service';
import { planExpansion, visibleChildCount } from './domain/tree-plan';
import { TeamRepository, type ChildCursor, type ChildNodeRow, type TeamNodeRow } from './team.repository';

/** A node of a bounded tree response before DTO mapping. */
export interface BuiltTreeNode {
  row: TeamNodeRow;
  /** Depth relative to the anchor (the viewer, or the admin-viewed member). */
  depth: number;
  /** Visible direct-referral count (0 at the depth limit). */
  childCount: number;
  children: BuiltTreeNode[];
  childrenLoaded: boolean;
  hasMoreChildren: boolean;
  childrenCursor: string | null;
}

export interface BuiltTree {
  root: BuiltTreeNode;
  truncated: boolean;
  /** Every node id in the response (root first, BFS order). */
  ids: string[];
}

const childCursorSchema = z.object({ at: z.iso.datetime(), id: z.uuid() });

export function encodeChildCursor(row: { attributedAt: Date; id: string }): string {
  return encodeCursor({ at: row.attributedAt.toISOString(), id: row.id });
}

/** Decodes a children-page cursor (400 VALIDATION_FAILED when tampered). */
export function decodeChildCursor(cursor: string | undefined): ChildCursor | undefined {
  const c = decodeCursor(cursor, childCursorSchema);
  return c ? { attributedAt: new Date(c.at), id: c.id } : undefined;
}

/**
 * Builds bounded tree responses level by level: each level fetches the children of the previous
 * level's nodes with one LATERAL query (≤ TREE_CHILDREN_LIMIT per node), stops at the requested
 * number of levels, never goes past `maxDepth`, and leaves branches unloaded once the node budget
 * (MAX_TREE_RESPONSE_NODES) is used up.
 */
@Injectable()
export class TeamTreeBuilder {
  constructor(private readonly repo: TeamRepository) {}

  async build(
    db: Db,
    input: { root: TeamNodeRow; rootDepth: number; levels: number; maxDepth: number | null },
  ): Promise<BuiltTree> {
    const { maxDepth } = input;
    const root = this.makeNode(input.root, input.rootDepth, maxDepth);
    const ids = [root.row.id];
    let frontier: BuiltTreeNode[] = [root];
    let budget = MAX_TREE_RESPONSE_NODES - 1;
    let truncated = false;

    for (let level = 0; level < input.levels && frontier.length > 0; level += 1) {
      const plan = planExpansion(
        frontier.map((n) => ({ id: n.row.id, depth: n.depth, childCount: n.row.childCount })),
        { budget, perParent: TREE_CHILDREN_LIMIT, maxDepth },
      );
      if (plan.deferred.length > 0) truncated = true;
      if (plan.expand.length === 0) break;

      const rows = await this.repo.childrenOfMany(db, plan.expand, TREE_CHILDREN_LIMIT);
      const byParent = groupByParent(rows);
      const byId = new Map(frontier.map((n) => [n.row.id, n]));
      const next: BuiltTreeNode[] = [];
      for (const parentId of plan.expand) {
        const parent = byId.get(parentId);
        if (!parent) continue;
        const childRows = byParent.get(parentId) ?? [];
        const page = childRows.slice(0, TREE_CHILDREN_LIMIT);
        parent.children = page.map((r) => this.makeNode(r, parent.depth + 1, maxDepth));
        parent.childrenLoaded = true;
        parent.hasMoreChildren = childRows.length > TREE_CHILDREN_LIMIT;
        const last = page[page.length - 1];
        parent.childrenCursor = parent.hasMoreChildren && last ? encodeChildCursor(last) : null;
        for (const child of parent.children) {
          next.push(child);
          ids.push(child.row.id);
        }
      }
      budget -= plan.added;
      frontier = next;
    }
    return { root, truncated, ids };
  }

  makeNode(row: TeamNodeRow, depth: number, maxDepth: number | null): BuiltTreeNode {
    const childCount = visibleChildCount(depth, row.childCount, maxDepth);
    return {
      row,
      depth,
      childCount,
      children: [],
      childrenLoaded: childCount === 0,
      hasMoreChildren: false,
      childrenCursor: null,
    };
  }
}

function groupByParent(rows: readonly ChildNodeRow[]): Map<string, ChildNodeRow[]> {
  const map = new Map<string, ChildNodeRow[]>();
  for (const row of rows) {
    const list = map.get(row.parentId);
    if (list) list.push(row);
    else map.set(row.parentId, [row]);
  }
  return map;
}
