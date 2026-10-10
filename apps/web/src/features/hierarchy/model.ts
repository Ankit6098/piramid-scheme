/**
 * Client-side model of the lazily loaded team tree. Pure functions (no React): the explorer keeps
 * the initial tree response plus a list of patches (expanded subtrees, "load more" pages, links
 * forced by search) and derives the model from them.
 */
import type { AnyMemberDto, AnyTreeNodeDto } from './types';

export interface ModelNode extends AnyMemberDto {
  parentId: string | null;
  /** Loaded children, in attribution order (first page from the tree, then "load more" pages). */
  childIds: string[];
  childrenLoaded: boolean;
  hasMoreChildren: boolean;
  childrenCursor: string | null;
}

export interface TreeModel {
  rootId: string | null;
  nodes: Readonly<Record<string, ModelNode>>;
}

export type TreePatch =
  | { kind: 'tree'; root: AnyTreeNodeDto; parentId: string | null }
  | { kind: 'children'; parentId: string; rows: AnyMemberDto[]; nextCursor: string | null }
  | { kind: 'link'; parentId: string; childId: string };

export const EMPTY_MODEL: TreeModel = { rootId: null, nodes: {} };

/** Most nodes rendered at once (canvas and outline). Beyond it, branches are cut and a notice shown. */
export const MAX_RENDERED_NODES = 400;

function memberFields(dto: AnyMemberDto): AnyMemberDto {
  return {
    id: dto.id,
    displayName: dto.displayName,
    depth: dto.depth,
    joinedAt: dto.joinedAt,
    statusBucket: dto.statusBucket,
    hasEligibleEnrollment: dto.hasEligibleEnrollment,
    childCount: dto.childCount,
    ...(dto.fullName !== undefined ? { fullName: dto.fullName } : {}),
    ...(dto.status !== undefined ? { status: dto.status } : {}),
    ...(dto.inScope !== undefined ? { inScope: dto.inScope } : {}),
  };
}

function mergeIds(first: readonly string[], extra: readonly string[]): string[] {
  const seen = new Set(first);
  const out = [...first];
  for (const id of extra) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function upsert(nodes: Record<string, ModelNode>, dto: AnyMemberDto, parentId: string | null): ModelNode {
  const existing = nodes[dto.id];
  const node: ModelNode = existing
    ? { ...existing, ...memberFields(dto), parentId: existing.parentId ?? parentId }
    : {
        ...memberFields(dto),
        parentId,
        childIds: [],
        childrenLoaded: dto.childCount === 0,
        hasMoreChildren: false,
        childrenCursor: null,
      };
  nodes[dto.id] = node;
  return node;
}

function applyTree(nodes: Record<string, ModelNode>, dto: AnyTreeNodeDto, parentId: string | null): void {
  const node = upsert(nodes, dto, parentId);
  if (dto.childrenLoaded) {
    const ids = dto.children.map((c) => c.id);
    const loadedMore = node.childIds.length > ids.length && node.childrenLoaded;
    nodes[dto.id] = {
      ...node,
      childIds: mergeIds(ids, node.childIds),
      childrenLoaded: true,
      hasMoreChildren: loadedMore ? node.hasMoreChildren : dto.hasMoreChildren,
      childrenCursor: loadedMore ? node.childrenCursor : dto.childrenCursor,
    };
  }
  for (const child of dto.children) applyTree(nodes, child, dto.id);
}

/** Applies patches in order to a base model (immutable: returns a new model). */
export function applyPatches(base: TreeModel, patches: readonly TreePatch[]): TreeModel {
  if (patches.length === 0) return base;
  const nodes: Record<string, ModelNode> = { ...base.nodes };
  let rootId = base.rootId;
  for (const patch of patches) {
    if (patch.kind === 'tree') {
      applyTree(nodes, patch.root, patch.parentId);
      rootId ??= patch.root.id;
    } else if (patch.kind === 'children') {
      const parent = nodes[patch.parentId];
      if (!parent) continue;
      for (const row of patch.rows) upsert(nodes, row, patch.parentId);
      nodes[patch.parentId] = {
        ...parent,
        childIds: mergeIds(parent.childIds, patch.rows.map((r) => r.id)),
        childrenLoaded: true,
        hasMoreChildren: patch.nextCursor !== null,
        childrenCursor: patch.nextCursor,
      };
    } else {
      const parent = nodes[patch.parentId];
      const child = nodes[patch.childId];
      if (!parent || !child) continue;
      if (!parent.childIds.includes(patch.childId)) {
        nodes[patch.parentId] = { ...parent, childIds: [...parent.childIds, patch.childId] };
      }
      if (!child.parentId) nodes[patch.childId] = { ...child, parentId: patch.parentId };
    }
  }
  return { rootId, nodes };
}

/** Builds the model from a tree response (the anchor at the root). */
export function modelFromTree(root: AnyTreeNodeDto | undefined): TreeModel {
  if (!root) return EMPTY_MODEL;
  return applyPatches(EMPTY_MODEL, [{ kind: 'tree', root, parentId: null }]);
}

/** Ids from `fromId` up to (and including) the model root, top first. */
export function pathToRoot(model: TreeModel, id: string): string[] {
  const out: string[] = [];
  let cur: ModelNode | undefined = model.nodes[id];
  const guard = new Set<string>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    out.unshift(cur.id);
    cur = cur.parentId ? model.nodes[cur.parentId] : undefined;
  }
  return out;
}

// ─── visible tree (what is rendered) ────────────────────────────────────────

export interface VisibleMember {
  kind: 'member';
  id: string;
  node: ModelNode;
  expanded: boolean;
  children: VisibleItem[];
}

export interface VisibleMore {
  kind: 'more';
  /** `more:<parentId>` */
  id: string;
  parentId: string;
  /** Children of the parent not loaded yet. */
  remaining: number;
  depth: number;
  children: VisibleItem[];
}

export type VisibleItem = VisibleMember | VisibleMore;

export interface VisibleTree {
  root: VisibleMember | null;
  /** Rendered member nodes. */
  count: number;
  /** True when MAX_RENDERED_NODES cut some expanded branches. */
  capped: boolean;
}

/**
 * The expanded part of the model below `rootId`, breadth-first within a node budget. Expanded nodes
 * whose children are not all loaded get a "load more" pseudo child.
 */
export function buildVisibleTree(
  model: TreeModel,
  rootId: string | null,
  isExpanded: (id: string) => boolean,
  budget = MAX_RENDERED_NODES,
): VisibleTree {
  const rootNode = rootId ? model.nodes[rootId] : undefined;
  if (!rootNode) return { root: null, count: 0, capped: false };
  const root: VisibleMember = { kind: 'member', id: rootNode.id, node: rootNode, expanded: isExpanded(rootNode.id), children: [] };
  let count = 1;
  let capped = false;
  const queue: VisibleMember[] = [root];
  while (queue.length > 0) {
    const item = queue.shift() as VisibleMember;
    if (!item.expanded) continue;
    const loaded = item.node.childIds.map((id) => model.nodes[id]).filter((n): n is ModelNode => Boolean(n));
    for (const child of loaded) {
      if (count >= budget) {
        capped = true;
        break;
      }
      const v: VisibleMember = { kind: 'member', id: child.id, node: child, expanded: isExpanded(child.id), children: [] };
      item.children.push(v);
      queue.push(v);
      count += 1;
    }
    const remaining = item.node.childCount - loaded.length;
    if (item.node.childrenLoaded && item.node.hasMoreChildren && remaining > 0 && item.children.length === loaded.length) {
      item.children.push({
        kind: 'more',
        id: `more:${item.id}`,
        parentId: item.id,
        remaining,
        depth: item.node.depth + 1,
        children: [],
      });
    }
  }
  return { root, count, capped };
}

/** Pre-order list of visible items (keyboard navigation order). */
export function flattenVisible(root: VisibleMember | null): VisibleItem[] {
  if (!root) return [];
  const out: VisibleItem[] = [];
  const walk = (item: VisibleItem) => {
    out.push(item);
    for (const c of item.children) walk(c);
  };
  walk(root);
  return out;
}

/** Label shown on a node: the full name in admin views when permitted, else the display name. */
export function nodeLabel(node: AnyMemberDto): string {
  return node.fullName ?? node.displayName;
}

/** Sequential single-hue depth color: full teal at level 1, fading toward the muted surface with depth. */
export function depthColor(depth: number): string {
  if (depth <= 0) return 'var(--foreground)';
  const pct = Math.max(30, 100 - (depth - 1) * 8);
  return `color-mix(in oklch, var(--primary) ${pct}%, var(--muted))`;
}
