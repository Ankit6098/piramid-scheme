import { describe, expect, it } from 'vitest';

import { applyPatches, buildVisibleTree, flattenVisible, modelFromTree, pathToRoot } from './model';
import type { AnyMemberDto, AnyTreeNodeDto } from './types';

function member(id: string, depth: number, childCount = 0): AnyMemberDto {
  return {
    id,
    displayName: `${id.toUpperCase()} X.`,
    depth,
    joinedAt: '2026-01-01T00:00:00.000Z',
    statusBucket: 'ACTIVE',
    hasEligibleEnrollment: false,
    childCount,
  };
}

function node(
  m: AnyMemberDto,
  children: AnyTreeNodeDto[] = [],
  extra: Partial<AnyTreeNodeDto> = {},
): AnyTreeNodeDto {
  return {
    ...m,
    children,
    childrenLoaded: children.length > 0 || m.childCount === 0,
    hasMoreChildren: false,
    childrenCursor: null,
    ...extra,
  };
}

// me ─┬─ a ── (a1 not loaded)
//     └─ b ─┬─ b1
//           └─ (3 more on the server)
const initial = node(member('me', 0, 2), [
  node(member('a', 1, 1)),
  node(member('b', 1, 4), [node(member('b1', 2))], { hasMoreChildren: true, childrenCursor: 'c1' }),
]);

describe('tree model', () => {
  it('builds nodes with parents and loading state', () => {
    const model = modelFromTree(initial);
    expect(model.rootId).toBe('me');
    expect(model.nodes.me?.childIds).toEqual(['a', 'b']);
    expect(model.nodes.a).toMatchObject({ parentId: 'me', childrenLoaded: false });
    expect(model.nodes.b).toMatchObject({ childIds: ['b1'], hasMoreChildren: true, childrenCursor: 'c1' });
    expect(pathToRoot(model, 'b1')).toEqual(['me', 'b', 'b1']);
  });

  it('merges a lazily loaded subtree and load-more pages without duplicates', () => {
    let model = modelFromTree(initial);
    model = applyPatches(model, [
      { kind: 'tree', root: node(member('a', 1, 1), [node(member('a1', 2))]), parentId: 'me' },
      { kind: 'children', parentId: 'b', rows: [member('b2', 2), member('b3', 2)], nextCursor: 'c2' },
      { kind: 'children', parentId: 'b', rows: [member('b3', 2), member('b4', 2)], nextCursor: null },
    ]);
    expect(model.nodes.a).toMatchObject({ childIds: ['a1'], childrenLoaded: true });
    expect(model.nodes.b).toMatchObject({ childIds: ['b1', 'b2', 'b3', 'b4'], hasMoreChildren: false, childrenCursor: null });
    // Re-fetching b's first page keeps the extra pages.
    model = applyPatches(model, [
      { kind: 'tree', root: node(member('b', 1, 4), [node(member('b1', 2))], { hasMoreChildren: true, childrenCursor: 'c1' }), parentId: 'me' },
    ]);
    expect(model.nodes.b?.childIds).toEqual(['b1', 'b2', 'b3', 'b4']);
    expect(model.nodes.b?.hasMoreChildren).toBe(false);
  });

  it('links a member that is beyond the first page of its parent', () => {
    let model = modelFromTree(initial);
    model = applyPatches(model, [
      { kind: 'tree', root: node(member('b9', 2)), parentId: 'b' },
      { kind: 'link', parentId: 'b', childId: 'b9' },
    ]);
    expect(model.nodes.b?.childIds).toEqual(['b1', 'b9']);
    expect(pathToRoot(model, 'b9')).toEqual(['me', 'b', 'b9']);
  });

  it('renders expanded nodes only, with load-more pseudo nodes and a node budget', () => {
    const model = modelFromTree(initial);
    const expanded = new Set(['me', 'b']);
    const visible = buildVisibleTree(model, 'me', (id) => expanded.has(id));
    expect(flattenVisible(visible.root).map((i) => i.id)).toEqual(['me', 'a', 'b', 'b1', 'more:b']);
    const more = flattenVisible(visible.root).find((i) => i.kind === 'more');
    expect(more).toMatchObject({ remaining: 3, parentId: 'b' });

    const capped = buildVisibleTree(model, 'me', (id) => expanded.has(id), 3);
    expect(capped.capped).toBe(true);
    expect(capped.count).toBe(3);
    expect(flattenVisible(capped.root).map((i) => i.id)).toEqual(['me', 'a', 'b']);
  });
});
