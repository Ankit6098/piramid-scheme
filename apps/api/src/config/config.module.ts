import { DynamicModule, Global, Module } from '@nestjs/common';
import { AppConfig, type AppConfigShape, loadConfig } from './app-config';

/** Global module exposing the validated `AppConfig`. */
@Global()
@Module({})
export class AppConfigModule {
  /** @param config pre-loaded config (main.ts/tests); defaults to `loadConfig()` (fails fast). */
  static forRoot(config?: AppConfigShape): DynamicModule {
    return {
      module: AppConfigModule,
      providers: [{ provide: AppConfig, useFactory: (): AppConfigShape => config ?? loadConfig() }],
      exports: [AppConfig],
    };
  }
}
