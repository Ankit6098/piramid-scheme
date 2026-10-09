import { Injectable, NotImplementedException } from '@nestjs/common';
import type { Db } from '../../common/prisma/prisma.service';

export interface AncestorRef {
  userId: string;
  /** 1 = direct sponsor, 2 = sponsor's sponsor, … */
  depth: number;
}

/**
 * CROSS-MODULE CONTRACT (owned by the referrals slice; consumed by the reward engine).
 */
@Injectable()
export class HierarchyService {
  /**
   * Ancestors of `userId` from the closure table (`referral_paths`), excluding the self row:
   * `SELECT ancestor_id, depth FROM referral_paths WHERE descendant_id = :userId AND depth BETWEEN 1 AND :maxDepth ORDER BY depth`.
   *
   * @param db       root client or the caller's transaction (the engine passes its tx).
   * @param maxDepth inclusive upper bound (the engine uses up to 50 for COMPRESS mode).
   * @returns ordered by depth ascending; empty for a root member. Depths are contiguous (tree).
   */
  async getAncestors(db: Db, userId: string, maxDepth: number): Promise<AncestorRef[]> {
    void db;
    void userId;
    void maxDepth;
    throw new NotImplementedException('referrals slice');
  }
}
