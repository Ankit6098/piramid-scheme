import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ScheduledJobsRegistry } from '../scheduler/scheduled-jobs.registry';

export const OUTBOX_RETENTION_DAYS = 14;

/** Example/core scheduled job: purges SENT outbox rows older than 14 days (DEAD rows are kept). */
@Injectable()
export class OutboxCleanupJob {
  private readonly logger = new Logger(OutboxCleanupJob.name);

  constructor(
    registry: ScheduledJobsRegistry,
    private readonly prisma: PrismaService,
  ) {
    registry.register({ name: 'outbox-cleanup', cron: '17 3 * * *', handler: async () => {
      await this.run();
    } });
  }

  async run(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - OUTBOX_RETENTION_DAYS * 86_400_000);
    const res = await this.prisma.outboxMessage.deleteMany({ where: { status: 'SENT', processedAt: { lt: cutoff } } });
    if (res.count) this.logger.log(`Purged ${res.count} delivered outbox messages`);
    return res.count;
  }
}
