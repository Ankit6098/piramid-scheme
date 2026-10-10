/**
 * Pure rules for building bounded team-tree responses (business rules §6: members see descendants
 * up to depth 10; responses never load the whole tree).
 */

export interface ExpandCandidate {
  id: string;
  /** Depth of the candidate relative to the viewer. */
  depth: number;
  /** All direct children of the candidate (before visibility capping). */
  childCount: number;
}

export interface ExpansionPlan {
  /** Candidates whose children are fetched in this round, in input (BFS) order. */
  expand: string[];
  /** Candidates with visible children that were left unloaded because of the node budget. */
  deferred: string[];
  /** Nodes the expanded candidates will add (Σ min(childCount, perParent)). */
  added: number;
}

/**
 * Children of `depth` are visible only while `depth < maxDepth` (null = unlimited, admin views).
 */
export function canSeeChildren(depth: number, maxDepth: number | null): boolean {
  return maxDepth === null || depth < maxDepth;
}

/** Direct-referral count as the viewer may see it (0 at the depth limit). */
export function visibleChildCount(depth: number, childCount: number, maxDepth: number | null): number {
  return canSeeChildren(depth, maxDepth) ? childCount : 0;
}

/**
 * Chooses which nodes of the current tree level get their children loaded, keeping the response
 * within `budget` additional nodes. Candidates are taken in order (so the first branches are always
 * expanded first); a candidate that would overflow the budget, and every one after it, is deferred.
 */
export function planExpansion(
  candidates: readonly ExpandCandidate[],
  opts: { budget: number; perParent: number; maxDepth: number | null },
): ExpansionPlan {
  const expand: string[] = [];
  const deferred: string[] = [];
  let added = 0;
  let full = false;
  for (const c of candidates) {
    const visible = visibleChildCount(c.depth, c.childCount, opts.maxDepth);
    if (visible === 0) continue;
    const cost = Math.min(visible, opts.perParent);
    if (full || added + cost > opts.budget) {
      full = true;
      deferred.push(c.id);
      continue;
    }
    expand.push(c.id);
    added += cost;
  }
  return { expand, deferred, added };
}
