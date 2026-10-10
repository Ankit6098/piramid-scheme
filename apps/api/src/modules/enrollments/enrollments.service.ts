import { Injectable } from '@nestjs/common';
import type { Db } from '../../common/prisma/prisma.service';

export interface EligibleEnrollmentRef {
  enrollmentId: string;
}

/**
 * CROSS-MODULE CONTRACT: reward eligibility from enrollment coverage (business rules §8.3).
 * The enrollments slice adds enrollment use cases to this service.
 */
@Injectable()
export class EnrollmentsService {
  /**
   * For each of `userIds`, finds an enrollment in `programId` whose coverage made the member
   * reward-eligible at the sale instant `at`. Determined by `at`, never by when processing runs:
   * - `eligibilityStatus = ELIGIBLE` and `effectiveFrom ≤ at < effectiveTo`, and
   * - `status IN (ACTIVE, EXPIRED)`, or `status = CANCELLED` with `at < cancelledAt`.
   *
   * @returns Map keyed by userId; members without such an enrollment are absent. One query.
   */
  async findEligibleEnrollments(
    db: Db,
    programId: string,
    userIds: string[],
    at: Date,
  ): Promise<Map<string, EligibleEnrollmentRef>> {
    const result = new Map<string, EligibleEnrollmentRef>();
    if (userIds.length === 0) return result;
    const rows = await db.programEnrollment.findMany({
      where: {
        programId,
        userId: { in: userIds },
        eligibilityStatus: 'ELIGIBLE',
        effectiveFrom: { lte: at },
        effectiveTo: { gt: at },
        OR: [{ status: { in: ['ACTIVE', 'EXPIRED'] } }, { status: 'CANCELLED', cancelledAt: { gt: at } }],
      },
      select: { id: true, userId: true },
      orderBy: { effectiveFrom: 'asc' },
    });
    for (const row of rows) {
      if (!result.has(row.userId)) result.set(row.userId, { enrollmentId: row.id });
    }
    return result;
  }
}
