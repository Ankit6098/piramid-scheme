import { DynamicModule, Module } from '@nestjs/common';
import { CommonModule } from './common/common.module';
import { LoggingModule } from './common/logging/logging.module';
import type { AppConfigShape } from './config/app-config';
import { AppConfigModule } from './config/config.module';
import { JobsModule } from './jobs/jobs.module';
import { FEATURE_MODULES } from './modules';

/**
 * Background worker root (no HTTP): outbox relay + scheduled jobs. Imports the feature modules so
 * their scheduled jobs / outbox handlers and services are available.
 */
@Module({})
export class WorkerModule {
  static forRoot(config?: AppConfigShape): DynamicModule {
    return {
      module: WorkerModule,
      imports: [AppConfigModule.forRoot(config), LoggingModule, CommonModule, JobsModule.forRoot({ role: 'worker' }), ...FEATURE_MODULES],
    };
  }
}
