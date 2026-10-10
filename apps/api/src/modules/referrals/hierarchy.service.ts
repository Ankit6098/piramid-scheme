import { Injectable } from '@nestjs/common';
import type { Db } from '../../common/prisma/prisma.service';

export interface AncestorRef {
  userId: string;
  /** 1 = direct sponsor, 2 = sponsor's sponsor, … */
  depth: number;
}

/**
 * CROSS-MODULE CONTRACT: referral-tree queries backed by the closure table (used by the reward
 * engine). Constructor-free on purpose (scripts build it by hand); the member team views live in
 * `TeamService`, the admin views in `AdminHierarchyService`.
 */
@Injectable()
export class HierarchyService {
  /**
   * Ancestors of `userId` (self row excluded), ordered by depth ascending; empty for a root member.
   * Uses the (descendant_id, depth) unique index.
   *
   * @param db       root client or the caller's transaction (the engine passes its tx).
   * @param maxDepth inclusive upper bound (the engine uses up to 50 for COMPRESS mode).
   */
  async getAncestors(db: Db, userId: string, maxDepth: number): Promise<AncestorRef[]> {
    if (maxDepth < 1) return [];
    const rows = await db.referralPath.findMany({
      where: { descendantId: userId, depth: { gte: 1, lte: maxDepth } },
      select: { ancestorId: true, depth: true },
      orderBy: { depth: 'asc' },
    });
    return rows.map((r) => ({ userId: r.ancestorId, depth: r.depth }));
  }
}
