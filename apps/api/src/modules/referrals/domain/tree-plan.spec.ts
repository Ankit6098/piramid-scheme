import { describe, expect, it } from 'vitest';
import { canSeeChildren, planExpansion, visibleChildCount } from './tree-plan';

describe('depth visibility', () => {
  it('hides children at the member depth limit', () => {
    expect(canSeeChildren(9, 10)).toBe(true);
    expect(canSeeChildren(10, 10)).toBe(false);
    expect(visibleChildCount(10, 7, 10)).toBe(0);
    expect(visibleChildCount(3, 7, 10)).toBe(7);
  });
  it('is unlimited for admin views', () => {
    expect(canSeeChildren(250, null)).toBe(true);
    expect(visibleChildCount(250, 4, null)).toBe(4);
  });
});

describe('planExpansion', () => {
  const opts = { budget: 100, perParent: 50, maxDepth: 10 };

  it('expands nodes with children in order and caps each at perParent', () => {
    const plan = planExpansion(
      [
        { id: 'a', depth: 1, childCount: 80 },
        { id: 'b', depth: 1, childCount: 0 },
        { id: 'c', depth: 1, childCount: 30 },
      ],
      opts,
    );
    expect(plan).toEqual({ expand: ['a', 'c'], deferred: [], added: 80 });
  });

  it('defers the rest once the budget would overflow', () => {
    const plan = planExpansion(
      [
        { id: 'a', depth: 1, childCount: 60 },
        { id: 'b', depth: 1, childCount: 45 },
        { id: 'c', depth: 1, childCount: 10 },
        { id: 'd', depth: 1, childCount: 1 },
      ],
      opts,
    );
    expect(plan).toEqual({ expand: ['a', 'b'], deferred: ['c', 'd'], added: 95 });
  });

  it('never expands nodes at the depth limit', () => {
    const plan = planExpansion([{ id: 'deep', depth: 10, childCount: 5 }], opts);
    expect(plan).toEqual({ expand: [], deferred: [], added: 0 });
  });
});
