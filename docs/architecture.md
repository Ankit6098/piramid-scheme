# Architecture

Modular monolith (see [ADR-0001](decisions/0001-modular-monolith-nestjs-nextjs.md)): one NestJS API
(`apps/api`) plus a background worker built from the same code, a Next.js web app (`apps/web`), and
a shared contracts package (`packages/shared`). Business rules live in
[business-rules.md](business-rules.md); the schema and its invariants in [database.md](database.md).

## API core & module contracts

The API core (`apps/api/src/common`, `src/config`, `src/jobs`, `src/bootstrap`, `main.ts`,
`worker.ts`) is shared infrastructure. Feature slices implement `src/modules/<module>/` and must not
need to edit core files. If a slice needs a core change, coordinate it.

### Layout

```
src/main.ts                    HTTP entry: loadConfig() → AppModule.forRoot(config) → configureApp() → listen
src/worker.ts                  Worker entry (no HTTP): WorkerModule.forRoot(config) — outbox relay + scheduled jobs
src/bootstrap/configure-app.ts configureApp(app, config): the HTTP pipeline, shared by main.ts and tests
src/app.module.ts              AppConfigModule, LoggingModule, CommonModule, HttpCoreModule, JobsModule, FEATURE_MODULES
src/worker.module.ts           AppConfigModule, LoggingModule, CommonModule, JobsModule(worker), FEATURE_MODULES
src/config/                    zod-validated env → typed AppConfig (fails fast)
src/common/                    cross-cutting code. Import from '../../common' (barrel)
src/jobs/                      outbox relay, email, notification handler, scheduler
src/modules/index.ts           FEATURE_MODULES (all 15 modules)
src/modules/<m>/               <m>.module.ts, <m>.controller.ts, <m>.service.ts, domain/*.ts (pure), dto.ts
src/generated/prisma/          Prisma 7 client (generated; `import { PrismaClient, Prisma } from '../generated/prisma/client'`)
prisma/seed.ts, seed-lib.ts    idempotent seed (roles/permissions/settings + SUPER_ADMIN); seedDemoData() stub
test/                          integration tests + utilities (see "Testing")
```

### Request pipeline

Express middleware, in order (from `configureApp`): `trust proxy` (TRUST_PROXY) → **request context**
(`x-request-id` is accepted if it matches `[A-Za-z0-9._:-]{8,64}`, otherwise a UUID is generated; it
is echoed in the response header and stored in AsyncLocalStorage) → helmet (CSP off for JSON, HSTS
in production) → CORS (origins = `CORS_ORIGINS` + `APP_PUBLIC_URL`, credentials) → cookie-parser →
JSON/urlencoded body parsers (**100 kb** limit) → Nest: pino-http → guards → pipe → handler →
interceptor → exception filter.

URLs: global prefix `api` + URI versioning (default version `1`) → `/api/v1/<controller path>`.
Swagger UI is at `/api/docs` (JSON at `/api/docs-json`) outside production, post-processed with
nestjs-zod `cleanupOpenApiDoc`. ETags are disabled. Shutdown hooks are enabled.

Global guards run in registration order (`HttpCoreModule`):

| # | Guard | Effect |
|---|---|---|
| 1 | `AppThrottlerGuard` | rate limits per client IP → 429 `RATE_LIMITED` |
| 2 | `CsrfGuard` | POST/PUT/PATCH/DELETE: `x-csrf-token` must equal the `csrf_token` cookie (constant-time compare). When `Origin` is present it must be allowed (`null` is rejected). Otherwise, when `Referer` is present, its origin must be allowed → 403 `CSRF_FAILED` |
| 3 | `SessionAuthGuard` | cookie `sid` → `AuthContext`; `/api/v1/admin/**` also needs `isAdmin` (403 `FORBIDDEN`) and `mfaVerified` (403 `MFA_REQUIRED`) |
| 4 | `PermissionsGuard` | `@RequirePermissions(...)`. All listed permissions are required → 403 `FORBIDDEN` with `details.missingPermissions` |

Global pipe: nestjs-zod `ZodValidationPipe`. Global interceptor: `JsonSafeInterceptor` (bigint →
decimal string; outside production it warns when a response is not a `{ data }` envelope). Global
filter: `AllExceptionsFilter`.

### Configuration (`src/config`)

`loadConfig()` loads `apps/api/.env` and then the repo-root `.env`. Real environment variables always
win. It then validates everything with zod and throws `ConfigValidationError`, which lists every bad
variable. Inject the config by class: `constructor(private readonly config: AppConfig)`. The shape
is `AppConfigShape` (`config.app.corsOrigins`, `config.security.sessionTtlHours`,
`config.throttle.auth`, …). Variables added by the core, all optional with defaults:
`TRUST_PROXY` (false | true = 1 hop | hop count | express string), `RUN_WORKER_IN_API` (false),
`DATABASE_POOL_MAX` (10), `THROTTLE_STORAGE` (memory|redis), `THROTTLE_{DEFAULT,AUTH,OTP}_LIMIT` and
`_TTL_SECONDS` (300/60, 10/60, 5/60). In production, `OTP_PEPPER` must be 64 hex characters.

### Responses, money and pagination

- Return envelopes explicitly: `return ok(dto)` → `{ data }`. For lists, use
  `return paginate(rows, limit, cursorOf, toDto)` → `{ data, page: { nextCursor, limit } }`.
- Fetch lists with `take: limit + 1`. Cursors are `encodeCursor(sortKey)` (base64url JSON). Always
  decode them with a schema: `decodeCursor(q.cursor, z.object({...}))`. A tampered cursor → 400
  `VALIDATION_FAILED`. The keyset example is in `common/pagination/cursor.ts`.
- `bigint` values are serialized as decimal strings by the interceptor (`toJsonSafe`), with an
  express `json replacer` as a backstop. `BigInt.prototype` is never patched.
- Map rows to explicit DTOs. Never return Prisma entities.

### Errors (`common/errors`)

Throw `AppError(code, message, httpStatus?, details?)` or a helper: `validationFailed`,
`unauthenticated`, `forbidden`, `mfaRequired`, `notFound('Program')`, `conflict`,
`invalidState(msg, details)`, `staleVersion`, `invariantViolation`, `rateLimited`, `csrfFailed`,
`serviceUnavailable`, `appError(code, msg)`. Default statuses per code are in `app-error.ts`.
`message` is shown to users. Never put secrets in `details`.

`AllExceptionsFilter` renders `{ error: { code, message, details?, requestId } }`:

| Thrown | Response |
|---|---|
| `AppError` | its status / code / details |
| nestjs-zod `ZodValidationException`, raw `ZodError` | 400 `VALIDATION_FAILED`, `details.issues[] = { path, message, code }` |
| `ThrottlerException` | 429 `RATE_LIMITED` (+ `Retry-After`) |
| SQLSTATE `23001` restrict_violation (our triggers), `23514` check_violation, `23P01` exclusion | 409 `INVARIANT_VIOLATION`, `details = { sqlState, constraint?, reason? }` |
| Prisma `P2002` / SQLSTATE `23505` | 409 `CONFLICT` (`details.constraint`) |
| Prisma `P2003` / `23503` (foreign key) | 409 `CONFLICT` |
| Prisma `P2025` | 404 `NOT_FOUND` |
| Prisma `P2034` / `40001` / `40P01` | 409 `CONFLICT` with `details.retryable` |
| invalid input value (`22P02`, `22001`, `P2000`, `P2007`, `P2023`) | 400 `VALIDATION_FAILED` |
| body-parser: too large / malformed JSON | 413 `PAYLOAD_TOO_LARGE` / 400 `VALIDATION_FAILED` |
| Nest `HttpException` | mapped by status (404 `NOT_FOUND`, 501 `NOT_IMPLEMENTED`, …) |
| anything else | 500 `INTERNAL_ERROR`, generic message. The stack is logged with the requestId |

How database errors are detected: Prisma 7 with `@prisma/adapter-pg` maps `23505`→P2002 and
`23503`/`23001`→P2003. Other SQLSTATEs become P2039 (or P2010 for raw queries). Deferred-trigger
failures at COMMIT become `DriverAdapterError`. The real SQLSTATE is in
`err.meta.driverAdapterError.cause.originalCode` or `err.cause.originalCode`. `inspectDbError()`
walks all of these, plus raw `pg` errors, and `mapDbError()` turns them into an `AppError`. Use
`mapDbError(err)` yourself when you need to branch on a DB failure, for example to turn a unique
violation into `ALREADY_ENROLLED`. Remember that a failed statement aborts the surrounding
Postgres transaction.

### Auth primitives (`common/auth`). The login flow belongs to the auth slice.

```ts
interface AuthContext {
  userId; sessionId; email; fullName;
  roles: RoleKey[]; permissions: ReadonlySet<Permission>;   // Set → map to an array before returning it
  programScopes: string[];   // program_admin_assignments (PROGRAM_ADMIN)
  isAdmin: boolean;          // any non-MEMBER role
  mfaVerified: boolean; sessionExpiresAt: Date;
}
```

- Every route is protected by default. `@Public()` skips auth. `@OptionalAuth()` makes a route
  public but resolves a valid session, used with `@CurrentUser({ optional: true })`.
  `@CurrentUser()` returns the `AuthContext` or 401. `@RequirePermissions(...perms)` requires all
  listed permissions. Never put `@Public()` on an `/admin` route.
- **Session resolution** (`SessionAuthService.resolve(token)`): `sha256(token)` → `sessions` row →
  rejects revoked, absolute-expired, and idle sessions. Idle means `lastSeenAt` is older than
  `SESSION_IDLE_TIMEOUT_MINUTES`; the session is then revoked with `idle_timeout`. The user must be
  `ACTIVE`: `SUSPENDED` → 403 `ACCOUNT_SUSPENDED`, any other status → 401. It loads roles,
  permissions (from `role_permissions`) and program scopes once per request, and refreshes
  `lastSeenAt` at most every 5 minutes. A dead cookie is cleared.
- **`assertProgramAccess(auth, programId, mode = 'write')`**: SUPER_ADMIN can access everything.
  PROGRAM_ADMIN can access only `programScopes`. FINANCE_REVIEWER gets `read` on every program and
  never `write`. Otherwise → 403. `canAccessProgram(...)` returns a boolean. For lists, use
  `programScopeFilter(auth, mode)`, which returns `'ALL' | string[]`.
- **`SessionTokenService`** (for the auth/users slices):
  - `createSession(tx, { userId, mfaVerified, ip, ua, ttlHours })` → `{ token, sessionId, expiresAt }`.
    Only the SHA-256 hash is stored. `ttlHoursFor(roles)` picks the admin TTL (12 h) or the member
    TTL (168 h).
  - `markMfaVerified(tx, sessionId)`, `revokeSession(tx, id, reason)`,
    `revokeAllForUser(tx, userId, reason, { exceptSessionId? })`.
  - `setSessionCookie(res, token, expiresAt)` / `clearSessionCookie(res)` set the `sid` cookie:
    HttpOnly, SameSite=Lax, `Secure` = `COOKIE_SECURE`, path `/`.
  - `issueCsrfToken(res)` sets a new `csrf_token` cookie (not HttpOnly) and returns the token.
    Call it on login and logout. `clearCsrfCookie(res)` removes it.
- `GET /api/v1/auth/csrf` (public, core-owned `CsrfController`) → `{ data: { csrfToken } }` plus the
  cookie. `@SkipCsrf()` is only for non-cookie callers, such as signed webhooks.

### Rate limiting (`common/throttle`)

`@nestjs/throttler` keyed by client IP. `req.ip` honours `X-Forwarded-For` only when
`TRUST_PROXY` is set. There are three throttlers:
- `default` applies to every route. Health checks use `@SkipDefaultThrottle()`.
- `auth` and `otp` are strict and opt-in per route: `@RateLimit('auth')`, `@RateLimit('otp')`, or
  `@RateLimit('otp', { limit: 3, ttl: 60_000 })` to override.

Storage is pluggable. It is in-memory by default. Set `THROTTLE_STORAGE=redis` to use
`RedisThrottlerStorage`, an atomic Lua fixed window shared by API replicas. Any other storage must
implement `ThrottlerStorage`. Per-account and per-email limits from business rules §2 are the auth
slice's job (DB counters).

### Validation and DTOs

Schemas live in `@app/shared` (`packages/shared/src/contracts/<module>.ts`). The API wraps them in
DTO classes:

```ts
import { createZodDto } from 'nestjs-zod';
export class CreateProgramDto extends createZodDto(createProgramSchema) {}
@Post() create(@Body() body: CreateProgramDto) {}          // validated + parsed output
@Get() list(@Query() q: ListQueryDto) {}                    // use z.coerce for numbers
@Get(':id') get(@Param() p: IdParamDto) {}                  // IdParamDto exported by common
```

A parameter whose type is not a DTO is not validated. Always use a DTO.
`@IdempotencyKey({ required })` reads `Idempotency-Key`, which must be 8–128 characters of
`[A-Za-z0-9_-:.]`, otherwise 400. Scope the key per actor and operation before storing it.

### Data access (`common/prisma`)

- `PrismaService` extends the generated `PrismaClient` and uses the pg driver adapter.
- `Tx = Prisma.TransactionClient`. `Db` is the same type: use it for helpers that run with or
  without a transaction (`PrismaService` is assignable to it).
- `prisma.runInTransaction(fn, { isolationLevel?, timeout = 15s, maxWait = 5s, retries = 0 })`.
  `retries` re-runs `fn` on serialization failures and deadlocks, so `fn` must be idempotent.
- `createPrismaClient(url)` is a Nest-free client for scripts and tests.
- Write `AuditService.record(tx, …)` and `OutboxService.enqueue(tx, …)` inside the business
  transaction. Never send email inside a DB transaction.
- Referral corrections: `await tx.$executeRaw\`SET LOCAL app.referral_correction = 'on'\`` inside the
  correction transaction.

### Cross-cutting services (global `CommonModule`; no import needed)

| Service | Contract |
|---|---|
| `AuditService.record(db, { action, resourceType, resourceId?, before?, after?, reason?, actorUserId?, actorRoles? })` | Takes `requestId`/`ip` from the request context and the actor + roles from the `AuthContext`. `actorUserId: null` records a system action with roles `['SYSTEM']`. `before`/`after` are JSON-normalized (bigint → string) and these keys are removed recursively: `password`, `passwordHash`, `code`, `codeHash`, `token`, `tokenHash`, `otp`, … |
| `OutboxService.enqueue(tx, { topic, payload, dedupeKey?, availableAt?, maxAttempts? })` | Returns `{ id, enqueued }`. A duplicate `dedupeKey` is a no-op (`ON CONFLICT DO NOTHING`) and does not abort the transaction. Topics are typed in `common/outbox/outbox.topics.ts`: `email.send` → `{ to, template, data }` with templates `otp`, `registration-attempt-existing-account`, `email-changed-notice`, `reward-status`, `enrollment-status`, `generic`; and `notification.create` → `{ userId, type, title, body, data? }` |
| `PlatformSettingsService.get(db?)` | The singleton row (created with defaults if missing). Without `db` it uses a 30 s cache. Pass the `tx` when the value drives a write. The settings slice must call `invalidate()` after updates. `toAmountFormat(settings)` (POINTS → 0 minor units) and `toCurrencyFormat(settings)` build `formatAmount()` inputs |
| `SessionTokenService`, `SessionAuthService` | see above |
| `RedisService` | lazy shared ioredis client (`redis`, `ping()`) |
| `RequestContext` | `requestId`, `ip`, `userAgent`, `auth`; `RequestContext.run({...}, fn)` for jobs |

Logging: inject the Nest `Logger` (`new Logger(Ctx.name)`). nestjs-pino is the app logger, writes
JSON (pretty only on a dev TTY), and adds `requestId` to every request-scoped line. These are
redacted: `authorization`, `cookie`, `x-csrf-token` and `set-cookie` headers, plus `password*`,
`code*`, `otp`, `token*` and `csrfToken` keys up to 4 levels deep. URLs are logged without query
strings. Never log OTPs, tokens or full email addresses (use `maskEmail()`).

### Background jobs (`src/jobs`)

- **Where jobs run:** `node dist/worker.js` (`WorkerModule`, no HTTP), or inside the API when
  `RUN_WORKER_IN_API=true`.
- **OutboxRelay:** every 2 s, and immediately again while batches are full, it claims up to 50 due
  rows (`PENDING`/`FAILED` with `available_at <= now()`, plus `PROCESSING` rows locked for more than
  5 min). The claim is one `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`,
  which sets `attempts + 1`. Each row is dispatched to its topic handler outside a transaction:
  - success → `SENT`;
  - error → `FAILED` with `available_at = now + backoff`, where backoff is 5 s·2^(n−1) ±20 %
    capped at 1 h;
  - `DEAD` once `attempts >= max_attempts` (8) or on `PermanentOutboxError`.
  
  Handlers can `scrub` the payload when the row ends: OTP codes are replaced with `[redacted]`.
  Delivery is at least once, so handlers must be idempotent. The notification handler uses the
  outbox id as the notification id.
- **Registering an outbox handler:** in a provider of your module,
  `constructor(r: OutboxHandlerRegistry) { r.register('topic', { handle, scrub? }) }`. New topics
  must be added to `outbox.topics.ts`; coordinate this.
- **Email:** `EmailService` sends over nodemailer SMTP (Mailpit in dev). Templates in
  `jobs/email/templates.ts` are pure functions that return `{ subject, text, html }` with HTML
  escaped. The OTP template has copy for each purpose. Amounts arrive pre-formatted
  (`amountFormatted`).
- **Scheduled jobs:** `ScheduledJobsRegistry.register({ name, everyMs | cron, tz?, handler })` from
  a provider in your module. They are installed as BullMQ job schedulers on queue `scheduled-jobs`;
  stale schedulers are removed and one run happens at a time. Handlers must be idempotent.
  `registry.runNow(name)` runs a job directly, for example in tests. Core registers
  `outbox-cleanup` (03:17 daily; deletes `SENT` rows older than 14 days). Planned jobs:
  `programs-status-transitions` (programs slice), `auth-session-cleanup` (auth slice), and
  enrollment expiry (enrollments slice).

### Cross-module contracts (stubs to implement)

These exist with typed signatures and full JSDoc. Their bodies throw
`NotImplementedException('<slice> slice')`, which surfaces as 501 `NOT_IMPLEMENTED`. The owning
slice implements the body and keeps the signature.

| Service (module) | Signature | Used by |
|---|---|---|
| `ReferralsService` (referrals) | `resolveCodeForRegistration(tx, code): Promise<{ sponsorUserId; referralCodeId }>`. Throws `REFERRAL_CODE_INVALID` | auth (register) |
| | `attachNewMember(tx, { userId, sponsorUserId?, referralCodeId? }): Promise<{ referralCode }>`. Writes the self closure row, the relationship, the ancestor paths and the member's code | auth (register) |
| `HierarchyService` (referrals) | `getAncestors(db, userId, maxDepth): Promise<{ userId; depth }[]>`, depth ≥ 1, ascending | rewards engine |
| `EnrollmentsService` (enrollments) | `findEligibleEnrollments(db, programId, userIds, at): Promise<Map<userId, { enrollmentId }>>` | rewards engine |
| `LedgerService` (ledger) | `postReward(tx, rewardId, actorUserId \| null): Promise<{ transactionId }>` and `reverseReward(tx, rewardId, actorUserId, reason)`. Both are idempotent by key | rewards, events |
| `RewardEngineService` (rewards) | `processEvent(eventId): Promise<{ outcome: 'REWARDS_CREATED' \| 'NO_ELIGIBLE_RECIPIENTS' \| 'ALREADY_PROCESSED' \| 'REJECTED'; rewardIds }>`. Opens its own transaction | events |
| `NotificationsService` (notifications) | `notify(tx, { userId, type, title, body, data?, dedupeKey? })`. **Implemented**: enqueues `notification.create` | everyone |

Pre-wired module imports: `AuthModule` imports Referrals and Notifications; `RewardsModule` imports
Referrals, Enrollments, Ledger and Notifications; `EventsModule` imports Rewards and Ledger. Avoid
import cycles: referrals, enrollments, ledger and notifications must not import rewards or events.
If a cycle is unavoidable, use `forwardRef`.

### Adding to a module (slice checklist)

1. Contracts: add zod schemas and response types to `packages/shared/src/contracts/<module>.ts`,
   then run `corepack pnpm --filter @app/shared build`.
2. DTOs: `src/modules/<m>/dto.ts` with `createZodDto(schema)`.
3. Controller (HTTP only): member routes go in `<m>.controller.ts`. Admin routes go in a separate
   `@Controller('admin/<resource>')`, which gets the admin + MFA requirement automatically; add
   `@RequirePermissions(...)` and call `assertProgramAccess` in the service. Return `ok()` /
   `paginate()`.
4. Service: use cases and transactions (`runInTransaction`), with audit and outbox writes inside
   them. Pure rules go in `domain/*.ts` with `*.spec.ts` next to them.
5. Register providers and controllers in `<m>.module.ts` (already in `FEATURE_MODULES`). A brand-new
   module must be added to `src/modules/index.ts`.
6. Tests: unit specs next to the code; integration specs in `test/<m>/*.int-spec.ts`.

Slices own their `src/modules/<m>/**`, `test/<m>/**` and `packages/shared/src/contracts/<m>.ts`.
Shared and core files (`src/common`, `src/jobs`, `src/config`, `test/utils`, `prisma/seed*.ts`,
`schema.prisma`) change only through coordination.

### Testing

- **Unit:** `corepack pnpm --filter @app/api test` runs Vitest with unplugin-swc, so decorator
  metadata works. It covers `src/**/*.spec.ts` and needs no database.
- **Integration:** `corepack pnpm --filter @app/api test:integration` covers `test/**/*.int-spec.ts`
  against real Postgres and Redis. It runs one file at a time in one worker. `globalSetup` creates
  the database named in `TEST_DATABASE_URL` if it is missing and runs `prisma migrate deploy`. The
  database name must contain `test`; this guards against truncating dev data.
- **A dedicated database per slice** avoids clashes between slices that run in parallel:
  ```bash
  docker compose exec -T postgres psql -U referral -d postgres -c 'CREATE DATABASE referral_test_auth'   # optional: globalSetup creates it
  TEST_DATABASE_URL=postgresql://referral:referral_dev_password@localhost:5432/referral_test_auth?schema=public \
    corepack pnpm --filter @app/api exec vitest run --config vitest.integration.config.ts test/auth
  ```
- `test/utils/db.ts`:
  - `testPrisma()` is a shared client for `TEST_DATABASE_URL`.
  - `resetDatabase()` runs TRUNCATE on every table except `_prisma_migrations` with
    `RESTART IDENTITY CASCADE`, then re-seeds roles, permissions and settings.
  - `disconnectTestPrisma()`.
- `test/utils/app.ts`:
  - `createTestApp({ env?, imports? })` builds the full `AppModule` with the same `configureApp()`
    as `main.ts`, with silent logs (`TEST_LOG_LEVEL=debug` to see them), no in-process worker and
    very high rate limits (override via `env`).
  - It returns `{ app, config, prisma, server, client(), clientWithSession(token), get(Token), close() }`.
  - `TestClient` sends its cookie jar on every request and adds a matching `csrf_token` cookie and
    `x-csrf-token` header to mutations. `.withoutCsrf()` and `.withHeaders({...})` adjust that.
- `test/utils/factories.ts`:
  - `createUser(prisma, { status, verified, roles, sponsorId, password?, programScopes?, … })`
    writes the user, roles, self and ancestor closure rows, the relationship and the referral code.
  - `loginAs(t, user, { mfaVerified? })` creates a session through `SessionTokenService` and
    returns a logged-in `TestClient` with `.sessionId`. `mfaVerified` defaults to true for admins.
  - `createOffering`, `createProgram(prisma, { status, options[] … })` (non-DRAFT programs get
    `publishedAt`).
  - `createPolicy(prisma, { programId, status, rules[], effectiveFrom/To … })`: rules are inserted
    while the policy is DRAFT, then the policy is published.
  - `createEnrollment(prisma, { userId, programId, status, … })`.
- `test/utils/probe.module.ts` shows how to mount test-only controllers:
  `createTestApp({ imports: [ProbeModule] })`.
- Core suites: `health`, `session-auth`, `csrf`, `throttle`, `db-invariants` (ledger balance at
  COMMIT, append-only tables, referral SET LOCAL guard, policy immutability and overlap, reward state
  machine, partial unique enrollment index) and `core-services` (outbox relay, email via Mailpit,
  notifications, audit redaction, settings cache).
