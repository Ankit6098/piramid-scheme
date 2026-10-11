import { Injectable, Logger } from '@nestjs/common';
import { OutboxTopic } from '../../common/outbox/outbox.topics';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ScheduledJobsRegistry } from '../scheduler/scheduled-jobs.registry';

export const OUTBOX_RETENTION_DAYS = 14;
/** Undelivered OTP emails older than this are useless (10-minute codes): mark DEAD + scrub. */
export const OTP_OUTBOX_MAX_AGE_MINUTES = 60;
/** Rows deleted per statement by the daily purge. */
export const OUTBOX_PURGE_BATCH = 5_000;

/**
 * Core scheduled job (03:17 daily, plus every 15 min for OTP rows):
 * - purges SENT outbox rows older than 14 days (DEAD rows are kept for investigation);
 * - marks undelivered `email.otp` rows older than an hour DEAD and removes their ciphertext, so a
 *   stopped worker never leaves encrypted codes lying around.
 */
@Injectable()
export class OutboxCleanupJob {
  private readonly logger = new Logger(OutboxCleanupJob.name);

  constructor(
    registry: ScheduledJobsRegistry,
    private readonly prisma: PrismaService,
  ) {
    registry.register({
      name: 'outbox-cleanup',
      cron: '17 3 * * *',
      handler: async () => {
        await this.run();
      },
    });
    registry.register({
      name: 'outbox-otp-expiry',
      everyMs: 15 * 60_000,
      handler: async () => {
        await this.expireOtpMessages();
      },
    });
  }

  async run(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - OUTBOX_RETENTION_DAYS * 86_400_000);
    // Bounded batches: every statement stays far below the session statement_timeout, however many
    // rows a day produced, and never holds row locks for long.
    let purged = 0;
    for (;;) {
      const n = await this.prisma.$executeRaw`
        DELETE FROM "outbox_messages"
         WHERE "id" IN (
           SELECT "id" FROM "outbox_messages"
            WHERE "status" = 'SENT' AND "processed_at" < ${cutoff}
            LIMIT ${OUTBOX_PURGE_BATCH}
         )`;
      purged += n;
      if (n < OUTBOX_PURGE_BATCH) break;
    }
    if (purged) this.logger.log(`Purged ${purged} delivered outbox messages`);
    await this.expireOtpMessages(now);
    return purged;
  }

  /** Returns the number of OTP messages that were given up (DEAD, ciphertext removed). */
  async expireOtpMessages(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - OTP_OUTBOX_MAX_AGE_MINUTES * 60_000);
    const count = await this.prisma.$executeRaw`
      UPDATE "outbox_messages"
         SET "status" = 'DEAD', "processed_at" = now(), "locked_at" = NULL,
             "last_error" = 'OTP email expired before delivery',
             "payload" = "payload" - 'codeCiphertext'
       WHERE "topic" = ${OutboxTopic.EmailOtp}
         AND "status" IN ('PENDING', 'FAILED', 'PROCESSING')
         AND "created_at" < ${cutoff}`;
    if (count) this.logger.warn(`Gave up ${count} undelivered OTP emails`);
    return count;
  }
}
