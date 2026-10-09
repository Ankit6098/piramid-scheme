import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { ZodValidationPipe } from 'nestjs-zod';
import { AppConfig } from '../config/app-config';
import { PermissionsGuard } from './auth/permissions.guard';
import { SessionAuthGuard } from './auth/session-auth.guard';
import { CsrfController } from './csrf/csrf.controller';
import { CsrfGuard } from './csrf/csrf.guard';
import { AllExceptionsFilter } from './errors/all-exceptions.filter';
import { HealthController } from './health/health.controller';
import { JsonSafeInterceptor } from './http/json-safe.interceptor';
import { RedisService } from './redis/redis.service';
import { RedisThrottlerStorage } from './throttle/redis-throttler.storage';
import { AppThrottlerGuard, buildThrottlerOptions } from './throttle/throttle';

/**
 * HTTP-only global enhancers (imported by AppModule only, never by the worker).
 * Guard order (registration order = execution order):
 *   1. AppThrottlerGuard  — rate limits (by IP)
 *   2. CsrfGuard          — double-submit token + Origin check on mutating requests
 *   3. SessionAuthGuard   — cookie session → AuthContext; /admin requires isAdmin + MFA
 *   4. PermissionsGuard   — @RequirePermissions(...)
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [AppConfig, RedisService],
      useFactory: (config: AppConfig, redis: RedisService) =>
        buildThrottlerOptions(
          config,
          config.throttle.storage === 'redis' ? new RedisThrottlerStorage(redis.redis) : undefined,
        ),
    }),
  ],
  controllers: [HealthController, CsrfController],
  providers: [
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: SessionAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: JsonSafeInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class HttpCoreModule {}
