/**
 * Public surface of the API core. Feature modules import from here:
 *   import { AppError, notFound, ok, paginate, PrismaService, type Tx, AuditService, ... } from '../../common';
 */
export * from './auth';
export * from './audit/audit.service';
export * from './audit/mask';
export * from './audit/redact';
export * from './context/request-context';
export * from './crypto';
export { SkipCsrf, checkCsrf } from './csrf/csrf.guard';
export * from './errors/app-error';
export { mapDbError, inspectDbError, SqlState } from './errors/db-error';
export { normalizeError, zodIssues } from './errors/all-exceptions.filter';
export * from './http/envelope';
export * from './http/json-safe';
export * from './idempotency/idempotency-key.decorator';
export * from './idempotency/idempotency.interceptor';
export * from './idempotency/idempotency.service';
export * from './idempotency/request-hash';
export * from './outbox/otp-mailer';
export * from './outbox/outbox.service';
export * from './outbox/outbox.topics';
export * from './pagination/cursor';
export * from './pagination/keyset';
export * from './prisma/prisma.service';
export * from './prisma/concurrency';
export * from './prisma/local-settings';
export * from './prisma/referral-tree-lock';
export * from './redis/redis.service';
export * from './settings/platform-settings.service';
export { RateLimit, SkipDefaultThrottle } from './throttle/throttle';
export * from './throttle/login-throttle.service';
export * from './validation/zod';
