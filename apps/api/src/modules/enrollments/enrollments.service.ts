import { Injectable, NotImplementedException } from '@nestjs/common';
import type { Db } from '../../common/prisma/prisma.service';

export interface EligibleEnrollmentRef {
  enrollmentId: string;
}

/**
 * CROSS-MODULE CONTRACT (owned by the enrollments slice; consumed by the reward engine).
 */
@Injectable()
export class EnrollmentsService {
  /**
   * For each of `userIds`, finds an enrollment in `programId` that makes the member reward-eligible
   * at instant `at` (business rules §8.3): `status = ACTIVE`, `eligibilityStatus = ELIGIBLE`,
   * `effectiveFrom ≤ at < effectiveTo` (a null effectiveTo counts as open-ended).
   *
   * @returns Map keyed by userId; users without such an enrollment are absent from the map.
   *          One query for all users (no N+1).
   */
  async findEligibleEnrollments(
    db: Db,
    programId: string,
    userIds: string[],
    at: Date,
  ): Promise<Map<string, EligibleEnrollmentRef>> {
    void db;
    void programId;
    void userIds;
    void at;
    throw new NotImplementedException('enrollments slice');
  }
}
