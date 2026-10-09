import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit/audit.service';
import { SessionAuthService } from './auth/session-auth.service';
import { SessionTokenService } from './auth/session-token.service';
import { OutboxService } from './outbox/outbox.service';
import { PrismaService } from './prisma/prisma.service';
import { RedisService } from './redis/redis.service';
import { PlatformSettingsService } from './settings/platform-settings.service';

/**
 * Global cross-cutting services available to every module without importing anything
 * (HTTP-free, so the worker uses it too). Requires AppConfigModule.
 */
@Global()
@Module({
  providers: [
    PrismaService,
    RedisService,
    AuditService,
    OutboxService,
    PlatformSettingsService,
    SessionTokenService,
    SessionAuthService,
  ],
  exports: [
    PrismaService,
    RedisService,
    AuditService,
    OutboxService,
    PlatformSettingsService,
    SessionTokenService,
    SessionAuthService,
  ],
})
export class CommonModule {}
