import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit/audit.service';
import { SessionAuthService } from './auth/session-auth.service';
import { SessionTokenService } from './auth/session-token.service';
import { CryptoService } from './crypto/crypto.service';
import { IdempotencyService } from './idempotency/idempotency.service';
import { OtpMailer } from './outbox/otp-mailer';
import { OutboxService } from './outbox/outbox.service';
import { PrismaService } from './prisma/prisma.service';
import { RedisService } from './redis/redis.service';
import { PlatformSettingsService } from './settings/platform-settings.service';
import { LoginThrottleService } from './throttle/login-throttle.service';

const SERVICES = [
  PrismaService,
  RedisService,
  CryptoService,
  AuditService,
  OutboxService,
  OtpMailer,
  PlatformSettingsService,
  SessionTokenService,
  SessionAuthService,
  IdempotencyService,
  LoginThrottleService,
];

/**
 * Global cross-cutting services available to every module without importing anything
 * (HTTP-free, so the worker uses it too). Requires AppConfigModule.
 */
@Global()
@Module({
  providers: SERVICES,
  exports: SERVICES,
})
export class CommonModule {}
