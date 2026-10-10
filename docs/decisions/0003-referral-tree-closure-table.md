# ADR-0003: Referral tree as adjacency list + closure table

- **Status:** Accepted
- **Date:** 2026-10-09

## Context

Every member has at most one sponsor (direct referrer). The resulting forest is read constantly:

- by the reward engine (the subject's ancestors in depth order, up to depth 10, or up to 50 for
  `COMPRESS`);
- by the member UI (own upline; downline to depth 10 with counts per level, search, pagination);
- by admins (team sizes, fraud signals).

Writes are rare: one insert at registration, plus occasional audited corrections that move a
subtree.

## Decision

Store the tree **twice**, in the same transaction:

1. **`referral_relationships`** (adjacency list): exactly one row per child (`child_user_id`
   unique) pointing to the sponsor, plus how it was attributed (`REGISTRATION` /
   `ADMIN_CORRECTION`) and the referral code used. This is the authoritative "who referred whom".
2. **`referral_paths`** (closure table): one row for every (ancestor, descendant) pair, **including
   a depth-0 self row** for every member. Primary key `(ancestor_id, descendant_id)`; unique
   `(descendant_id, depth)` (one ancestor per level, so the structure is a tree); index
   `(ancestor_id, depth)`.

- Registration inserts the member's self row, plus one row per ancestor of the sponsor, at depth + 1.
- Corrections (SUPER_ADMIN, `referrals:correct`) delete the paths from the old upline to the
  moved subtree and insert the cross product of the new upline and the subtree. They run in one
  transaction with `SET LOCAL app.referral_correction = 'on'` and write `referral_corrections` and
  the audit log. Outside that flag, UPDATE and DELETE on both tables are rejected by trigger.
- Cycles cannot occur: a new member has no descendants, and a correction is rejected when the new
  sponsor is the member or inside the member's subtree (one indexed `EXISTS` on the closure).

Query patterns (children, descendants by depth, ancestors, ancestor at depth N, team size per
depth, search within a team) are in [docs/database.md](../database.md#referral-tree-closure-table-and-its-write-protocol).

## Consequences

- Upline and downline reads are single indexed range scans. No recursive CTE runs on the hot path,
  and depth limits are a simple `depth BETWEEN 1 AND 10`.
- Storage is O(n × average depth). That is fine for referral trees, which are wide rather than
  deep. Depth is bounded by a CHECK (≤ 1000) as a sanity limit.
- Moving a subtree costs O(subtree × upline) row writes. This is acceptable for rare admin
  corrections, which are serialized.
- The two structures must stay consistent. Both are written only by the referral service inside
  one transaction, and a consistency query (adjacency recursion vs. closure) is documented for
  reconciliation and tests.
- Corrections affect only future reward calculations. Past calculations keep their recorded trace.

## Alternatives considered

- **Adjacency list + recursive CTEs only:** simplest writes, but every reward calculation and
  every team page would run a recursive query.
- **Materialized path (`ltree`):** fast subtree reads. However, moving a subtree rewrites every
  descendant's path, "ancestor at depth N" is awkward, and the extension adds operational surface.
- **Nested sets:** cheap reads, but expensive inserts that rewrite large parts of the table on
  every registration. Unsuitable for an append-heavy tree.
- **Graph database:** a second datastore with no transactional link to rewards and the ledger.
