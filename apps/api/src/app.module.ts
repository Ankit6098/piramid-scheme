import { DynamicModule, Module } from '@nestjs/common';
import { CommonModule } from './common/common.module';
import { HttpCoreModule } from './common/http-core.module';
import { LoggingModule } from './common/logging/logging.module';
import type { AppConfigShape } from './config/app-config';
import { AppConfigModule } from './config/config.module';
import { JobsModule } from './jobs/jobs.module';
import { FEATURE_MODULES } from './modules';

/** HTTP application root. Use `AppModule.forRoot(config)` (main.ts, test/utils/app.ts). */
@Module({})
export class AppModule {
  static forRoot(config?: AppConfigShape): DynamicModule {
    return {
      module: AppModule,
      imports: [
        AppConfigModule.forRoot(config),
        LoggingModule,
        CommonModule,
        HttpCoreModule,
        JobsModule.forRoot({ role: 'api' }),
        ...FEATURE_MODULES,
      ],
    };
  }
}
