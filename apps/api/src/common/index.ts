/**
 * Public surface of the API core. Feature modules import from here:
 *   import { AppError, notFound, ok, paginate, PrismaService, type Tx, AuditService, ... } from '../../common';
 */
export * from './auth';
export * from './audit/audit.service';
export * from './audit/redact';
export * from './context/request-context';
export * from './crypto/tokens';
export { SkipCsrf, checkCsrf } from './csrf/csrf.guard';
export * from './errors/app-error';
export { mapDbError, inspectDbError, SqlState } from './errors/db-error';
export { normalizeError, zodIssues } from './errors/all-exceptions.filter';
export * from './http/envelope';
export * from './http/json-safe';
export * from './idempotency/idempotency-key.decorator';
export * from './outbox/outbox.service';
export * from './outbox/outbox.topics';
export * from './pagination/cursor';
export * from './prisma/prisma.service';
export * from './redis/redis.service';
export * from './settings/platform-settings.service';
export { RateLimit, SkipDefaultThrottle } from './throttle/throttle';
export * from './validation/zod';
