import { Injectable } from '@nestjs/common';
import type { MemberStatusBucket, UserStatus } from '@app/shared';
import type { Db } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';

/** Attributes of one team member, as selected for tree/list responses. */
export interface TeamNodeRow {
  id: string;
  fullName: string;
  status: UserStatus;
  joinedAt: Date;
  /** Holds an ELIGIBLE enrollment whose coverage contains now (any program). */
  hasEligible: boolean;
  /** All direct referrals (callers cap it at the viewer's depth limit). */
  childCount: number;
}

export interface ChildNodeRow extends TeamNodeRow {
  parentId: string;
  attributedAt: Date;
}

export interface DepthCountRow {
  depth: number;
  count: number;
  active: number;
  eligible: number;
}

export interface PathRow {
  id: string;
  fullName: string;
  /** Distance from the path's bottom member (0 = the member itself). */
  up: number;
}

export interface SearchRow {
  id: string;
  fullName: string;
  status: UserStatus;
  depth: number;
}

export interface AncestorRow {
  id: string;
  fullName: string;
  status: UserStatus;
  joinedAt: Date;
  depth: number;
}

/** Keyset position in a sponsor's children (attribution order). */
export interface ChildCursor {
  attributedAt: Date;
  id: string;
}

// ─── SQL fragments (alias `u` = users) ──────────────────────────────────────

/**
 * Same coverage rule as EnrollmentsService.findEligibleEnrollments, evaluated at now(). Lists
 * evaluate it (and CHILD_COUNT) only for the rows of the page: they select the page in a
 * MATERIALIZED CTE with its LIMIT first, so the planner probes program_enrollments(user_id, …) per
 * row instead of hashing the whole enrollments table for every page.
 */
const ELIGIBLE_NOW = Prisma.sql`EXISTS (
  SELECT 1 FROM "program_enrollments" e
  WHERE e."user_id" = u."id"
    AND e."eligibility_status" = 'ELIGIBLE'
    AND e."effective_from" <= now() AND e."effective_to" > now()
    AND (e."status" IN ('ACTIVE', 'EXPIRED') OR (e."status" = 'CANCELLED' AND e."cancelled_at" > now()))
)`;

/** Direct referrals, via the (sponsor_user_id, attributed_at) index. */
const CHILD_COUNT = Prisma.sql`(SELECT count(*) FROM "referral_relationships" cr WHERE cr."sponsor_user_id" = u."id")::int`;

const NODE_COLUMNS = Prisma.sql`u."id", u."full_name" AS "fullName", u."status"::text AS "status",
  u."created_at" AS "joinedAt", ${ELIGIBLE_NOW} AS "hasEligible", ${CHILD_COUNT} AS "childCount"`;

/**
 * SQL mirror of `toDisplayName()` (first name + last initial). Searches by members match this
 * expression so they never reveal hidden parts of another member's name.
 */
const DISPLAY_NAME = Prisma.sql`(CASE WHEN btrim(u."full_name") ~ '\\s'
  THEN split_part(regexp_replace(btrim(u."full_name"), '\\s+', ' ', 'g'), ' ', 1) || ' ' ||
       upper(left(regexp_replace(btrim(u."full_name"), '^.*\\s', ''), 1)) || '.'
  ELSE btrim(u."full_name") END)`;

/**
 * Read-side queries over the referral tree. Everything is bounded: subtree membership, depth and
 * counts come from the closure table (`referral_paths`, indexes (ancestor_id, depth) and
 * (descendant_id, depth)); child lists use the adjacency index with a per-parent LIMIT. Nothing
 * here ever loads a whole tree.
 */
@Injectable()
export class TeamRepository {
  /** A single member's node attributes (null when the user does not exist). */
  async node(db: Db, userId: string): Promise<TeamNodeRow | null> {
    const rows = await db.$queryRaw<TeamNodeRow[]>`
      SELECT ${NODE_COLUMNS} FROM "users" u WHERE u."id" = ${userId}::uuid`;
    return rows[0] ?? null;
  }

  /**
   * Depth of `descendantId` below `ancestorId` (0 = same member), or null when it is not in the
   * subtree. One primary-key lookup.
   */
  async depthBetween(db: Db, ancestorId: string, descendantId: string): Promise<number | null> {
    const row = await db.referralPath.findUnique({
      where: { ancestorId_descendantId: { ancestorId, descendantId } },
      select: { depth: true },
    });
    return row?.depth ?? null;
  }

  /**
   * Children of several parents at once, at most `perParent + 1` each (the extra row tells the
   * caller there are more), oldest attribution first.
   */
  async childrenOfMany(db: Db, parentIds: readonly string[], perParent: number): Promise<ChildNodeRow[]> {
    if (parentIds.length === 0) return [];
    return db.$queryRaw<ChildNodeRow[]>`
      WITH page AS MATERIALIZED (
        SELECT par."id" AS "parent_id", c."child_user_id", c."attributed_at"
        FROM unnest(${[...parentIds]}::uuid[]) AS par("id")
        CROSS JOIN LATERAL (
          SELECT r."child_user_id", r."attributed_at"
          FROM "referral_relationships" r
          WHERE r."sponsor_user_id" = par."id"
          ORDER BY r."attributed_at" ASC, r."child_user_id" ASC
          LIMIT ${perParent + 1}
        ) c
      )
      SELECT page."parent_id" AS "parentId", page."attributed_at" AS "attributedAt", ${NODE_COLUMNS}
      FROM page
      JOIN "users" u ON u."id" = page."child_user_id"
      ORDER BY page."parent_id", page."attributed_at" ASC, page."child_user_id" ASC`;
  }

  /** One page of a parent's children after `after` (keyset), oldest first; fetches `limit + 1`. */
  async childrenPage(db: Db, parentId: string, after: ChildCursor | undefined, limit: number): Promise<ChildNodeRow[]> {
    const keyset = after
      ? Prisma.sql`AND (r."attributed_at", r."child_user_id") > (${after.attributedAt}::timestamptz, ${after.id}::uuid)`
      : Prisma.empty;
    return db.$queryRaw<ChildNodeRow[]>`
      WITH page AS MATERIALIZED (
        SELECT r."sponsor_user_id", r."child_user_id", r."attributed_at"
        FROM "referral_relationships" r
        WHERE r."sponsor_user_id" = ${parentId}::uuid ${keyset}
        ORDER BY r."attributed_at" ASC, r."child_user_id" ASC
        LIMIT ${limit + 1}
      )
      SELECT page."sponsor_user_id" AS "parentId", page."attributed_at" AS "attributedAt", ${NODE_COLUMNS}
      FROM page
      JOIN "users" u ON u."id" = page."child_user_id"
      ORDER BY page."attributed_at" ASC, page."child_user_id" ASC`;
  }

  /** Direct referrals of a sponsor, newest attribution first (keyset), optionally by status bucket. */
  async directReferrals(
    db: Db,
    sponsorId: string,
    opts: { status?: MemberStatusBucket; before?: ChildCursor; limit: number },
  ): Promise<ChildNodeRow[]> {
    const statusFilter =
      opts.status === 'ACTIVE'
        ? Prisma.sql`AND u."status" = 'ACTIVE'`
        : opts.status === 'INACTIVE'
          ? Prisma.sql`AND u."status" <> 'ACTIVE'`
          : Prisma.empty;
    const keyset = opts.before
      ? Prisma.sql`AND (r."attributed_at", r."child_user_id") < (${opts.before.attributedAt}::timestamptz, ${opts.before.id}::uuid)`
      : Prisma.empty;
    return db.$queryRaw<ChildNodeRow[]>`
      WITH page AS MATERIALIZED (
        SELECT r."sponsor_user_id", r."child_user_id", r."attributed_at"
        FROM "referral_relationships" r
        JOIN "users" u ON u."id" = r."child_user_id"
        WHERE r."sponsor_user_id" = ${sponsorId}::uuid ${statusFilter} ${keyset}
        ORDER BY r."attributed_at" DESC, r."child_user_id" DESC
        LIMIT ${opts.limit + 1}
      )
      SELECT page."sponsor_user_id" AS "parentId", page."attributed_at" AS "attributedAt", ${NODE_COLUMNS}
      FROM page
      JOIN "users" u ON u."id" = page."child_user_id"
      ORDER BY page."attributed_at" DESC, page."child_user_id" DESC`;
  }

  /** Per-depth counts of the subtree below `ancestorId` (depth ≥ 1, ≤ maxDepth unless null). */
  async depthCounts(db: Db, ancestorId: string, maxDepth: number | null): Promise<DepthCountRow[]> {
    const depthLimit = maxDepth === null ? Prisma.empty : Prisma.sql`AND p."depth" <= ${maxDepth}`;
    return db.$queryRaw<DepthCountRow[]>`
      SELECT d."depth", count(*)::int AS "count",
             count(*) FILTER (WHERE d."active")::int AS "active",
             count(*) FILTER (WHERE d."eligible")::int AS "eligible"
      FROM (
        SELECT p."depth", (u."status" = 'ACTIVE') AS "active", ${ELIGIBLE_NOW} AS "eligible"
        FROM "referral_paths" p
        JOIN "users" u ON u."id" = p."descendant_id"
        WHERE p."ancestor_id" = ${ancestorId}::uuid AND p."depth" >= 1 ${depthLimit}
      ) d
      GROUP BY d."depth"
      ORDER BY d."depth"`;
  }

  /**
   * The chain from `descendantId` up `depth` levels (inclusive of both ends), bottom first
   * (`up` = 0 is the descendant itself).
   */
  async pathUp(db: Db, descendantId: string, depth: number): Promise<PathRow[]> {
    return db.$queryRaw<PathRow[]>`
      SELECT p."ancestor_id" AS "id", p."depth" AS "up", u."full_name" AS "fullName"
      FROM "referral_paths" p
      JOIN "users" u ON u."id" = p."ancestor_id"
      WHERE p."descendant_id" = ${descendantId}::uuid AND p."depth" <= ${depth}
      ORDER BY p."depth" ASC`;
  }

  /** Ancestors of a member (sponsor first), at most `maxDepth` levels unless null. */
  async ancestors(db: Db, userId: string, maxDepth: number | null): Promise<AncestorRow[]> {
    const depthLimit = maxDepth === null ? Prisma.empty : Prisma.sql`AND p."depth" <= ${maxDepth}`;
    return db.$queryRaw<AncestorRow[]>`
      SELECT p."ancestor_id" AS "id", p."depth", u."full_name" AS "fullName",
             u."status"::text AS "status", u."created_at" AS "joinedAt"
      FROM "referral_paths" p
      JOIN "users" u ON u."id" = p."ancestor_id"
      WHERE p."descendant_id" = ${userId}::uuid AND p."depth" >= 1 ${depthLimit}
      ORDER BY p."depth" ASC`;
  }

  /**
   * Name search inside the subtree of `ancestorId` (depth 1..maxDepth). Members match the display
   * name only (`matchFullName = false`); admins match the full name. Uses the trigram index on
   * users.full_name for the prefilter / full-name pattern. Keyset on (depth, id).
   */
  async search(
    db: Db,
    opts: {
      ancestorId: string;
      maxDepth: number | null;
      pattern: string;
      prefilter: string | null;
      matchFullName: boolean;
      /** Restrict to members enrolled in these programs (PROGRAM_ADMIN scope). */
      programIds?: readonly string[] | null;
      after?: { depth: number; id: string };
      limit: number;
    },
  ): Promise<SearchRow[]> {
    const depthLimit = opts.maxDepth === null ? Prisma.empty : Prisma.sql`AND p."depth" <= ${opts.maxDepth}`;
    const prefilter = opts.prefilter ? Prisma.sql`AND u."full_name" ILIKE ${opts.prefilter} ESCAPE '\\'` : Prisma.empty;
    const match = opts.matchFullName
      ? Prisma.sql`AND u."full_name" ILIKE ${opts.pattern} ESCAPE '\\'`
      : Prisma.sql`AND ${DISPLAY_NAME} ILIKE ${opts.pattern} ESCAPE '\\'`;
    const scope = opts.programIds
      ? Prisma.sql`AND EXISTS (SELECT 1 FROM "program_enrollments" se WHERE se."user_id" = u."id" AND se."program_id" = ANY(${[...opts.programIds]}::uuid[]))`
      : Prisma.empty;
    const keyset = opts.after
      ? Prisma.sql`AND (p."depth", u."id") > (${opts.after.depth}::int, ${opts.after.id}::uuid)`
      : Prisma.empty;
    return db.$queryRaw<SearchRow[]>`
      SELECT u."id", u."full_name" AS "fullName", u."status"::text AS "status", p."depth"
      FROM "referral_paths" p
      JOIN "users" u ON u."id" = p."descendant_id"
      WHERE p."ancestor_id" = ${opts.ancestorId}::uuid AND p."depth" >= 1
        ${depthLimit} ${prefilter} ${match} ${scope} ${keyset}
      ORDER BY p."depth" ASC, u."id" ASC
      LIMIT ${opts.limit + 1}`;
  }

  /** Members of the subtree rooted at `userId`, including the member. */
  async subtreeSize(db: Db, userId: string): Promise<number> {
    return db.referralPath.count({ where: { ancestorId: userId } });
  }

  /** RECEIVED (unprocessed) sales whose subject is in the subtree rooted at `userId`. */
  async receivedEventsInSubtree(db: Db, userId: string): Promise<number> {
    const rows = await db.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS "count"
      FROM "qualifying_events" q
      JOIN "referral_paths" p ON p."descendant_id" = q."subject_user_id"
      WHERE p."ancestor_id" = ${userId}::uuid AND q."status" = 'RECEIVED'`;
    return rows[0]?.count ?? 0;
  }

  /** Subset of `userIds` enrolled (any status) in one of `programIds`. */
  async enrolledIn(db: Db, userIds: readonly string[], programIds: readonly string[]): Promise<Set<string>> {
    if (userIds.length === 0 || programIds.length === 0) return new Set();
    const rows = await db.programEnrollment.findMany({
      where: { userId: { in: [...userIds] }, programId: { in: [...programIds] } },
      select: { userId: true },
      distinct: ['userId'],
    });
    return new Set(rows.map((r) => r.userId));
  }
}
