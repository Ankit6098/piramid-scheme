import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ScheduledJobsRegistry } from '../../jobs/scheduler/scheduled-jobs.registry';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** A pending registration can be re-sent for this long after its last code expired. */
export const PENDING_REGISTRATION_RETENTION_MS = DAY_MS;
/** Challenge rows (history for the 24 h limits) and dead sessions are deleted after this. */
export const AUTH_HISTORY_RETENTION_MS = 30 * DAY_MS;

export interface ChallengeCleanupResult {
  scrubbed: number;
  deleted: number;
}

/**
 * Housekeeping for the auth tables (idempotent; one run at a time per job):
 * - `auth-challenge-cleanup` (every 15 min): removes the pending registration payload (name +
 *   password hash + referral code) from challenges that were consumed, invalidated or expired more
 *   than a day ago; deletes challenge rows older than 30 days.
 * - `auth-session-cleanup` (daily): deletes sessions that expired or were revoked more than 30 days
 *   ago (LOGIN_MFA challenges bound to them go with them).
 */
@Injectable()
export class AuthJobs {
  private readonly logger = new Logger(AuthJobs.name);

  constructor(
    registry: ScheduledJobsRegistry,
    private readonly prisma: PrismaService,
  ) {
    registry.register({ name: 'auth-challenge-cleanup', everyMs: 15 * 60_000, handler: async () => void (await this.cleanupChallenges()) });
    registry.register({ name: 'auth-session-cleanup', cron: '41 3 * * *', handler: async () => void (await this.cleanupSessions()) });
  }

  async cleanupChallenges(now: Date = new Date()): Promise<ChallengeCleanupResult> {
    const scrub = await this.prisma.emailChallenge.updateMany({
      where: {
        OR: [{ pendingPasswordHash: { not: null } }, { pendingFullName: { not: null } }, { pendingReferralCodeId: { not: null } }],
        AND: [
          {
            OR: [
              { consumedAt: { not: null } },
              { invalidatedAt: { not: null } },
              { expiresAt: { lt: new Date(now.getTime() - PENDING_REGISTRATION_RETENTION_MS) } },
            ],
          },
        ],
      },
      data: { pendingFullName: null, pendingPasswordHash: null, pendingReferralCodeId: null },
    });
    const deleted = await this.prisma.emailChallenge.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - AUTH_HISTORY_RETENTION_MS) } },
    });
    if (scrub.count || deleted.count) {
      this.logger.log({ scrubbed: scrub.count, deleted: deleted.count }, 'Email challenge cleanup');
    }
    return { scrubbed: scrub.count, deleted: deleted.count };
  }

  async cleanupSessions(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - AUTH_HISTORY_RETENTION_MS);
    const res = await this.prisma.session.deleteMany({
      where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
    });
    if (res.count) this.logger.log({ deleted: res.count }, 'Session cleanup');
    return res.count;
  }
}
