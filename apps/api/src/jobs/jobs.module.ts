import { DynamicModule, Global, Module } from '@nestjs/common';
import { AppConfig } from '../config/app-config';
import { EmailOutboxHandler } from './email/email.handler';
import { EmailService } from './email/email.service';
import { OtpEmailOutboxHandler } from './email/otp-email.handler';
import { IdempotencyCleanupJob } from './idempotency/idempotency-cleanup.job';
import { JOBS_OPTIONS, type JobsModuleOptions } from './jobs.options';
import { NotificationOutboxHandler } from './notifications/notification.handler';
import { OutboxCleanupJob } from './outbox/outbox-cleanup.job';
import { OutboxHandlerRegistry } from './outbox/outbox-handler.registry';
import { OutboxRelay } from './outbox/outbox-relay.service';
import { ScheduledJobsRegistry } from './scheduler/scheduled-jobs.registry';
import { SchedulerRunner } from './scheduler/scheduler.runner';

/**
 * Background processing: outbox relay (+ email / notification handlers) and scheduled jobs.
 * Global so feature modules can inject `ScheduledJobsRegistry` / `OutboxHandlerRegistry`.
 * Processing runs in dist/worker.js, or inside the API when RUN_WORKER_IN_API=true.
 */
@Global()
@Module({})
export class JobsModule {
  static forRoot(opts: { role: 'api' | 'worker' }): DynamicModule {
    return {
      module: JobsModule,
      providers: [
        {
          provide: JOBS_OPTIONS,
          inject: [AppConfig],
          useFactory: (config: AppConfig): JobsModuleOptions => ({
            role: opts.role,
            processing: opts.role === 'worker' || config.worker.runInApi,
          }),
        },
        OutboxHandlerRegistry,
        ScheduledJobsRegistry,
        EmailService,
        EmailOutboxHandler,
        OtpEmailOutboxHandler,
        NotificationOutboxHandler,
        OutboxRelay,
        OutboxCleanupJob,
        IdempotencyCleanupJob,
        SchedulerRunner,
      ],
      exports: [JOBS_OPTIONS, OutboxHandlerRegistry, ScheduledJobsRegistry, EmailService, OutboxRelay],
    };
  }
}
