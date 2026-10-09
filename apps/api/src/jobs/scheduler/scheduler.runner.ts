import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import { AppConfig } from '../../config/app-config';
import { RequestContext } from '../../common/context/request-context';
import { bullConnectionOptions } from '../../common/redis/redis.service';
import { JOBS_OPTIONS, type JobsModuleOptions } from '../jobs.options';
import { ScheduledJobsRegistry } from './scheduled-jobs.registry';

export const SCHEDULED_JOBS_QUEUE = 'scheduled-jobs';

/**
 * Installs BullMQ job schedulers for every registered ScheduledJobDefinition (removing stale ones) and
 * runs a BullMQ Worker that dispatches each fired job to its handler. Active only where job
 * processing is enabled (worker process, or API with RUN_WORKER_IN_API=true).
 */
@Injectable()
export class SchedulerRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SchedulerRunner.name);
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(
    private readonly registry: ScheduledJobsRegistry,
    private readonly config: AppConfig,
    @Inject(JOBS_OPTIONS) private readonly options: JobsModuleOptions,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.options.processing) return;
    const connection = bullConnectionOptions(this.config.redis.url);
    this.queue = new Queue(SCHEDULED_JOBS_QUEUE, { connection });
    this.queue.on('error', (err) => this.logger.warn(`Scheduler queue error: ${err.message}`));

    const jobs = this.registry.list();
    const wanted = new Set(jobs.map((j) => j.name));
    for (const existing of await this.queue.getJobSchedulers(0, -1)) {
      const id = existing.key;
      if (!wanted.has(id)) {
        await this.queue.removeJobScheduler(id);
        this.logger.log(`Removed stale job scheduler "${id}"`);
      }
    }
    for (const job of jobs) {
      await this.queue.upsertJobScheduler(
        job.name,
        job.cron ? { pattern: job.cron, ...(job.tz ? { tz: job.tz } : {}) } : { every: job.everyMs! },
        { name: job.name, data: {}, opts: { removeOnComplete: 100, removeOnFail: 500 } },
      );
    }

    this.worker = new Worker(SCHEDULED_JOBS_QUEUE, (j: Job) => this.dispatch(j), { connection, concurrency: 1 });
    this.worker.on('failed', (j, err) => this.logger.error({ job: j?.name, err }, 'Scheduled job failed'));
    this.worker.on('error', (err) => this.logger.warn(`Scheduler worker error: ${err.message}`));
    this.logger.log(`Scheduler started (${jobs.map((j) => j.name).join(', ') || 'no jobs'})`);
  }

  private async dispatch(job: Job): Promise<void> {
    const def = this.registry.get(job.name);
    if (!def) {
      this.logger.warn(`No handler for scheduled job "${job.name}"`);
      return;
    }
    const started = Date.now();
    await RequestContext.run({ requestId: `job:${job.name}:${job.id ?? 'manual'}` }, () => def.handler());
    this.logger.log({ job: job.name, durationMs: Date.now() - started }, 'Scheduled job completed');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
    this.worker = null;
    this.queue = null;
  }
}
