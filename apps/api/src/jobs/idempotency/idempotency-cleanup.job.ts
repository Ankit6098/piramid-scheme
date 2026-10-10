import { Injectable, Logger } from '@nestjs/common';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { ScheduledJobsRegistry } from '../scheduler/scheduled-jobs.registry';

/** Hourly purge of expired `idempotency_keys` rows (24 h TTL). */
@Injectable()
export class IdempotencyCleanupJob {
  private readonly logger = new Logger(IdempotencyCleanupJob.name);

  constructor(
    registry: ScheduledJobsRegistry,
    private readonly idempotency: IdempotencyService,
  ) {
    registry.register({
      name: 'idempotency-keys-cleanup',
      cron: '41 * * * *',
      handler: async () => {
        await this.run();
      },
    });
  }

  async run(now = new Date()): Promise<number> {
    const count = await this.idempotency.purgeExpired(now);
    if (count) this.logger.log(`Purged ${count} expired idempotency keys`);
    return count;
  }
}
