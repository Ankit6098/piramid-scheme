# Architecture

Modular monolith (see [ADR-0001](decisions/0001-modular-monolith-nestjs-nextjs.md)): one NestJS API
(`apps/api`) plus a background worker built from the same code, a Next.js web app (`apps/web`), and
a shared contracts package (`packages/shared`). Business rules live in
[business-rules.md](business-rules.md); the schema and its invariants in [database.md](database.md);
the endpoint index in [api.md](api.md); the web conventions in [frontend.md](frontend.md).

## Contents

1. [System overview](#system-overview)
2. [Module map](#module-map)
3. [Request and processing flows](#request-and-processing-flows)
4. [API core & module contracts](#api-core--module-contracts) (layout, pipeline, config, errors,
   auth primitives, crypto, rate limiting, validation, idempotency, data access, cross-cutting
   services, background jobs, cross-module contracts, testing)

## System overview

```
 browser ──▶ nginx (single origin, :8080 / :443)
               ├── /api/*  ──▶ api   (NestJS: guards → controller → service → domain; Prisma → PostgreSQL)
               └── /*      ──▶ web   (Next.js App Router; server code calls api via API_INTERNAL_URL)
 api, worker ──▶ PostgreSQL 17 (all state, invariants in SQL)    ──▶ Redis 7 (BullMQ schedulers,
 worker      ──▶ SMTP (Mailpit in dev)                                rate-limit + login-backoff counters)
 sales system ──▶ POST /api/v1/integrations/events (API key) ──▶ api
```

- **api** (`node dist/main.js`): HTTP only. Writes business state, audit rows and outbox messages
  in one transaction. Never sends email itself.
- **worker** (`node dist/worker.js`, same image and modules, no HTTP): the outbox relay (email,
  OTP email, notifications, fraud signal) and the scheduled jobs. `RUN_WORKER_IN_API=true` runs it
  inside the API for development.
- **web**: renders the member area (`(member)/…`), the admin area (`admin/…`) and the auth pages
  (`(auth)/…`); session-dependent data is fetched on the client with TanStack Query through
  `/api`. Hiding UI is never the authorization; the API guards are.
- **PostgreSQL** enforces the money, tree, compliance and segregation-of-duties invariants with
  constraints and triggers, so a bug in one module cannot corrupt another's data
  ([ADR-0002](decisions/0002-prisma-with-raw-sql-invariants.md)).

## Module map

Sixteen feature modules in `apps/api/src/modules` (registered in `FEATURE_MODULES`, loaded by
both the API and the worker), on top of the global core in `src/common` and `src/jobs`.

| Module | Responsibility | Routes | Exports (used by other modules) | Imports |
|---|---|---|---|---|
| `auth` | Registration with deferred user creation, email verification, login/logout, password reset, admin MFA (email OTP → TOTP enrollment/verification), one-time-code issuance and limits, security notices. Jobs: `auth-challenge-cleanup`, `auth-session-cleanup` | `/auth/*`, `/auth/mfa/*` | `AuthService`, `MfaService`, `OtpService`, `PasswordService`, `SecurityNoticesService` | referrals, notifications |
| `users` | Self-service account: profile, password change, email change, sessions, activity, TOTP reset | `/users/me` | `UsersService` | auth |
| `settings` | Platform settings (unit, currency, points label, defaults) and the currency list, on top of the core `PlatformSettingsService` | `/settings/public`, `/admin/settings`, `/admin/currencies` | `SettingsService` | — |
| `offerings` | Products/services and their approval | `/admin/offerings` | `OfferingsService` | — |
| `programs` | Programs, plans (options), lifecycle state machine with reasons, program-admin assignments, member catalogue. Job: `programs-status-transitions` | `/programs`, `/admin/programs` | `ProgramsService`, `ProgramLifecycleService` | — |
| `enrollments` | Enroll, cancel, offline-payment activation, rejection, coverage periods. Job: `enrollments-expiry` | `/programs/:id/enrollments`, `/users/me/enrollments`, `/admin/enrollments` | `EnrollmentsService` (**`findEligibleEnrollments`**) | notifications |
| `referrals` | Referral codes, attribution at account creation, upline lookup, member and admin team views, sponsor corrections, member flags, the shared-IP fraud signal (outbox handler) | `/referrals/validate`, `/users/me/{referral-code,parent,referrals,hierarchy}`, `/admin/members/:id/{hierarchy,ancestors,sponsor-correction}`, `/admin/flags` | `ReferralsService` (**`resolveCodeForRegistration`, `attachNewMember`**), `HierarchyService` (**`getAncestors`**) | — |
| `policies` | Reward policy drafts, validation, dry-run (the engine's pure calculator), publish/retire timeline, member policy view | `/admin/programs/:id/{policies,policy-context}`, `/admin/policies`, `/programs/:id/policy` | `PoliciesService` | referrals, enrollments |
| `events` | Sale intake: validation, sale-level idempotency and revisions, REJECTED storage, event queries. Job: `events-received-sweeper` | `/admin/events` | `EventIntakeService`, `EventsQueryService` | rewards, ledger |
| `integrations` | API clients (keys shown once, SHA-256 stored), bearer-key guard, machine ingestion into the same intake | `/admin/integrations/clients`, `/integrations/events` | `IntegrationsService` | events |
| `rewards` | The reward engine (calculation + persistence), reward queries, approve/reject/reverse/bulk, event reversal, CSV, member rewards and earnings | `/admin/rewards`, `/admin/events/:id/reverse`, `/users/me/{rewards,earnings}` | `RewardEngineService` (**`processEvent`**), `RewardsQueryService`, `RewardDecisionsService`, `EventReversalService` | referrals, enrollments, ledger, notifications |
| `ledger` | Double-entry posting and reversal, account get-or-create, ledger queries, CSV | `/admin/ledger` | `LedgerService` (**`postReward`, `reverseReward`**), `LedgerQueryService` | — |
| `reconciliation` | Eight SQL consistency checks, cached report | `/admin/reconciliation` | `ReconciliationService` (**`countExceptions`**) | — |
| `notifications` | In-app notifications: `notify(tx, …)` enqueues `notification.create`; member read routes | `/users/me/notifications` | `NotificationsService` (**`notify`**) | — |
| `audit` | Audit log queries and field diffs (writing is the core `AuditService`) | `/admin/audit` | `AuditQueryService` | — |
| `admin` | Admin overview, member administration (suspend, reactivate, roles), member dashboard | `/admin/overview`, `/admin/members`, `/users/me/dashboard` | `AdminMembersService` | audit, notifications, reconciliation |

Dependency direction (arrows = "imports"). Leaf modules never import `rewards` or `events`, so
there are no cycles and no `forwardRef`:

```
 users ──▶ auth ──▶ referrals
             └────▶ notifications ◀─────────────┐
 integrations ──▶ events ──▶ rewards ──▶ referrals, enrollments ──▶ notifications
                    └──────────┴──────▶ ledger
 policies ──▶ referrals, enrollments            (+ the pure rewards/domain/reward-calculator)
 admin ──▶ audit, notifications, reconciliation
 settings, offerings, programs, ledger, reconciliation, audit, notifications, referrals: no feature imports
```

**Cross-module contracts.** Modules talk through these service methods (and through the database
invariants), never by writing each other's tables ad hoc:

| Contract | Owner → consumers | Semantics |
|---|---|---|
| `ReferralsService.resolveCodeForRegistration(tx, code)` | referrals → auth | Active code owned by an ACTIVE, verified member → `{ sponsorUserId, referralCodeId }`, else `REFERRAL_CODE_INVALID` |
| `ReferralsService.attachNewMember(tx, { userId, sponsorUserId?, referralCodeId?, registrationIp?, registrationUserAgent? })` | referrals → auth | Runs the registration write protocol inside the caller's transaction (shared tree lock → self row → relationship → ancestor rows → own code) and enqueues `fraud.registration-attributed` |
| `HierarchyService.getAncestors(db, userId, maxDepth)` | referrals → rewards, policies | Upline `{ userId, depth }[]`, depth ≥ 1 ascending, from the closure table |
| `EnrollmentsService.findEligibleEnrollments(db, programId, userIds, at)` | enrollments → rewards, policies | Who held an ELIGIBLE enrollment covering instant `at` (ACTIVE/EXPIRED, or CANCELLED before `cancelledAt`); one query |
| `RewardEngineService.processEvent(eventId)` | rewards → events (intake, sweeper) | Opens its own transaction; idempotent (`ALREADY_PROCESSED`); outcomes `REWARDS_CREATED`, `NO_ELIGIBLE_RECIPIENTS`, `REJECTED` |
| `LedgerService.postReward(tx, rewardId, actorUserId \| null)` / `reverseReward(tx, rewardId, actorUserId, reason)` | ledger → rewards | Writes the exact two-entry posting / mirror reversal and **moves the reward to POSTED / REVERSED itself**; idempotent by key (`created: false` on replay) |
| `NotificationsService.notify(tx, { userId, type, title, body, data?, dedupeKey? })` | notifications → everyone | Enqueues `notification.create` in the caller's transaction |
| `ReconciliationService.countExceptions()` | reconciliation → admin | Exception total from the cached report |
| `ProgramLifecycleService.transition(...)` | programs (internal + scheduler) | The only writer of program status (with `app.status_reason`) |

## Request and processing flows

### Registration → verification → attribution

```
 Browser              API (auth, referrals)                                     DB / worker
 ───────              ─────────────────────                                     ───────────
 POST /auth/register  validate referralCode (resolveCodeForRegistration)
 {name,email,pw,ref}  argon2id(password) — always, for equal timing
                      tx: lock (7302, 'EMAIL_VERIFICATION:<email>')
                          account exists? → notice to owner (≤ 1/h), nothing else
                          else invalidate older pending challenge,
                               INSERT email_challenges (pending name, hash, code id),
                               OtpMailer.enqueue → outbox 'email.otp' {challengeId, codeCiphertext}
 ◀── 202 (identical for known and unknown addresses)                            relay: decrypt → SMTP →
                                                                                scrub ciphertext (SENT)
 POST /auth/verify-email {email, code, password}
                      UPDATE … attempts + 1 … RETURNING; constant-time HMAC compare;
                      argon2 verify password vs pending hash (dummy hash on a wrong code)
                      tx (one, no savepoints):
                          consume challenge (conditional UPDATE)
                          INSERT users (ACTIVE, email verified, pending password hash)
                          re-validate the stored code (no longer valid → root member, reported)
                          attachNewMember: lock_shared(7301,1) → self row → relationship
                                           (+ registration IP/UA) → ancestor rows → own code
                                           → outbox 'fraud.registration-attributed'
                          MEMBER role → session → audit 'user.register'
                      COMMIT: deferred closure-consistency check
 ◀── 200 + sid cookie + new csrf_token                                          worker: ≥ 3 attributions per
                                                                                (sponsor, IP, 24 h) → OPEN flag
```

No users row exists until the mailbox owner proves control, so nobody can squat an address or bind
it to a sponsor ([ADR-0010](decisions/0010-deferred-user-creation-anti-squatting.md)).

### Admin sign-in (TOTP)

```
 POST /auth/login ──▶ session WITHOUT a second factor ──▶ { mfaRequired: true, method }
   method = TOTP_ENROLLMENT (no authenticator yet):
     POST /auth/mfa/email/send → code bound to THIS session → POST /auth/mfa/email/verify
        → session rotated, mfaMethod = EMAIL_OTP (no admin access)
     POST /auth/mfa/totp/setup → otpauth URI (secret stored AES-256-GCM, unconfirmed)
     POST /auth/mfa/totp/confirm → factor confirmed → session rotated, mfaMethod = TOTP
   method = TOTP:
     POST /auth/mfa/totp/verify (replay-safe step) → session rotated, mfaMethod = TOTP
 /api/v1/admin/** now passes: adminAccess = admin role ∧ mfaMethod = TOTP ∧ verified < 12 h
```

Details: [ADR-0009](decisions/0009-totp-admin-mfa-session-rotation.md), [api/identity.md](api/identity.md).

### Sale intake → engine → approval → ledger

```
 POST /admin/events (admin, events:write)      POST /integrations/events (Bearer API key)
          └──────────────┬─────────────────────────────┘
                         ▼
 EventIntakeService.record
   scope + recorder SoD (an admin never records a sale for self/downline)
   sale idempotency: (offering, externalId, revision) + requestHash
       same hash → replay │ other facts, live revision → 409 IDEMPOTENCY_CONFLICT │ REJECTED/REVERSED → revision + 1
   business validation → INSERT REJECTED (reason)  or  INSERT RECEIVED       [trg_events_insert_guard]
   audit 'event.record' ─ COMMIT
                         │ after commit (and every minute: events-received-sweeper, RECEIVED > 2 min)
                         ▼
 RewardEngineService.processEvent(eventId)          (own transaction)
   event FOR UPDATE; skip unless RECEIVED
   lock_shared(7301,1)  (waits for an in-flight sponsor correction)
   program ACTIVE at occurredAt? policy in effect? subject ACTIVE? → else event REJECTED
   bind policy                                          [DB re-checks applicability]
   HierarchyService.getAncestors + EnrollmentsService.findEligibleEnrollments(at = occurredAt)
   reward-calculator (pure): base → budget (≤ 50 %) → per-level amounts → allocation
   INSERT reward_calculations                            [DB re-derives base, checks cap]
   INSERT rewards  PENDING_APPROVAL  (APPROVED only: auto-approving policy ∧ not ADMIN_MANUAL)
       auto-approved → LedgerService.postReward → POSTED
   event PROCESSED; audit; notify recipients (outbox)
   COMMIT: Σ rewards = calculation total; ledger shape/balance; status ⇔ ledger
                         │
                         ▼
 POST /admin/rewards/:id/approve   (rewards:approve, Idempotency-Key)
   tx: event FOR SHARE → reward FOR UPDATE → SoD (not own reward, not the sale's recorder)
       PENDING_APPROVAL → APPROVED → LedgerService.postReward:
           DEBIT platform expense / CREDIT recipient payable, 'reward-posting:<id>' → POSTED
       audit 'reward.approve' + notification 'reward.posted'
   COMMIT: deferred ledger + SoD checks
 POST /admin/rewards/:id/reverse  → 'reward-reversal:<id>' mirror → REVERSED
 POST /admin/events/:id/reverse   → event REVERSED first (row lock), then PENDING/APPROVED → REJECTED,
                                    POSTED → REVERSED; COMMIT refuses any live reward left behind
```

Members then see the reward (§10 fields only) and their earnings, computed from the ledger
(`/users/me/rewards`, `/users/me/earnings`). The reconciliation report re-proves the ledger and
status invariants continuously.

### Sponsor correction protocol

```
 GET  /admin/members/:id/sponsor-correction/preview?newSponsorId   (referrals:correct)
      → affected members, issues (SELF_SPONSOR, CYCLE, SAME_SPONSOR, SPONSOR_INACTIVE,
        SEGREGATION_OF_DUTIES, RECEIVED_EVENTS), canApply
 POST /admin/members/:id/sponsor-correction { newSponsorId, reason ≥ 10 }
   tx (one, no savepoints):
     pg_advisory_xact_lock(7301, 1)              exclusive: no registration or engine read in between
     re-evaluate every rule under the lock
     INSERT referral_corrections                 [trigger: lock held, no cycle, performer not an upline of the new sponsor]
     SET LOCAL app.referral_correction_id = id   (only this transaction can now modify the tree)
     UPDATE referral_relationships (source = ADMIN_CORRECTION)   [cycle check]
     DELETE closure rows: old strict ancestors × moved subtree
     INSERT closure rows: new sponsor's ancestors-or-self × moved subtree
     audit 'referral.correct'
   COMMIT: every touched member's closure rows = its sponsor's rows + 1
```

Only calculations made afterwards use the new placement; past rewards never change. SQL and
guards: [database.md](database.md#write-protocol-db-enforced), API: [api/network.md](api/network.md).

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
src/modules/index.ts           FEATURE_MODULES (all 16 modules, see "Module map")
src/modules/<m>/               <m>.module.ts, <m>.controller.ts, <m>.service.ts, domain/*.ts (pure), dto.ts
src/generated/prisma/          Prisma 7 client (generated; `import { PrismaClient, Prisma } from '../generated/prisma/client'`)
prisma/seed.ts, seed-lib.ts    idempotent seed (roles/permissions/settings + SUPER_ADMIN via the referral write protocol)
prisma/seed-demo.ts            SEED_DEMO_DATA=true: demo program, tree, enrollments, sales, approvals through the real services
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
| 3 | `SessionAuthGuard` | cookie `sid` → `AuthContext`; `/api/v1/admin/**` also needs an admin role (403 `FORBIDDEN`) and `adminAccess` = TOTP verified in this session within 12 h (403 `MFA_REQUIRED`, `details.reason` `TOTP_ENROLLMENT_REQUIRED` or `TOTP_REQUIRED`) |
| 4 | `PermissionsGuard` | `@RequirePermissions(...)`. All listed permissions are required → 403 `FORBIDDEN` with `details.missingPermissions` |

Global pipe: nestjs-zod `ZodValidationPipe`. Global interceptors: `JsonSafeInterceptor` (bigint →
decimal string; outside production it warns when a response is not a `{ data }` envelope) and,
inside it, `IdempotencyInterceptor` (only acts on `@Idempotent()` routes). Global filter:
`AllExceptionsFilter`.

### Configuration (`src/config`)

`loadConfig()` loads `apps/api/.env` and then the repo-root `.env`. Real environment variables always
win. It then validates everything with zod and throws `ConfigValidationError`, which lists every bad
variable. Inject the config by class: `constructor(private readonly config: AppConfig)`. The shape
is `AppConfigShape` (`config.app.corsOrigins`, `config.security.sessionTtlHours`,
`config.throttle.auth`, `config.loginThrottle`, …).

Required secrets: `OTP_PEPPER` (≥ 32 chars; 64 hex in production), `OTP_OUTBOX_KEY` and
`MFA_ENCRYPTION_KEY` (64 hex chars = 32-byte AES-256-GCM keys; `openssl rand -hex 32`). The three
must differ. Optional, with defaults: `TRUST_PROXY` (false | true = 1 hop | hop count | express
string), `RUN_WORKER_IN_API` (false), `DATABASE_POOL_MAX` (10), `THROTTLE_STORAGE` (memory|redis),
`THROTTLE_{DEFAULT,AUTH,OTP}_LIMIT` and `_TTL_SECONDS` (300/60, 10/60, 5/60), `MFA_TOTP_ISSUER`
("Referral Platform"), `LOGIN_THROTTLE_FREE_ATTEMPTS` (5), `LOGIN_THROTTLE_IP_FREE_ATTEMPTS` (20),
`LOGIN_THROTTLE_BASE_SECONDS` (30), `LOGIN_THROTTLE_MAX_SECONDS` (900),
`LOGIN_THROTTLE_WINDOW_SECONDS` (86400).

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
  programScopes: string[];          // program_admin_assignments (PROGRAM_ADMIN)
  isAdmin: boolean;                 // holds any non-MEMBER role
  mfaMethod: 'EMAIL_OTP' | 'TOTP' | null;   // second factor completed in THIS session
  mfaVerifiedAt: Date | null;
  hasTotpFactor: boolean;           // confirmed, non-revoked user_mfa_factors row of kind TOTP
  adminAccess: boolean;             // isAdmin && mfaMethod === 'TOTP' && mfaVerifiedAt within 12 h
  sessionExpiresAt: Date;
}
```

- Every route is protected by default. `@Public()` skips auth. `@OptionalAuth()` makes a route
  public but resolves a valid session, used with `@CurrentUser({ optional: true })`.
  `@CurrentUser()` returns the `AuthContext` or 401. `@RequirePermissions(...perms)` requires all
  listed permissions. Never put `@Public()` on an `/admin` route.
- **Session resolution** (`SessionAuthService.resolve(token)`): `sha256(token)` → `sessions` row →
  rejects revoked, absolute-expired, and idle sessions. Idle means `lastSeenAt` is older than
  `SESSION_IDLE_TIMEOUT_MINUTES`; the session is then revoked with `idle_timeout`. The user must be
  `ACTIVE`: `SUSPENDED` → 403 `ACCOUNT_SUSPENDED`, any other status → 401. Roles, permissions (from
  `role_permissions`), program scopes and `hasTotpFactor` are loaded **on every request** (no
  cache: a role grant/revoke applies to the next request). `adminAccess` is computed by the pure
  `computeAdminAccess()` (`ADMIN_MFA_MAX_AGE_MS` = 12 h). `lastSeenAt` is refreshed at most every
  5 minutes. A dead cookie is cleared.
- **Admin area:** `/api/v1/admin/**` (matched case-insensitively) → non-admin: 403 `FORBIDDEN`;
  admin without `adminAccess`: 403 `MFA_REQUIRED` with `details.reason` =
  `TOTP_ENROLLMENT_REQUIRED` (no confirmed TOTP factor yet) or `TOTP_REQUIRED` (factor exists, but
  this session has no TOTP verification within 12 h). Email OTP never grants admin access.
  (`MfaRequiredReason` in `@app/shared`; pure check `assertAdminAccess(auth)`.)
- **`assertProgramAccess(auth, programId, mode = 'write')`**: SUPER_ADMIN can access everything.
  PROGRAM_ADMIN can access only `programScopes`. FINANCE_REVIEWER gets `read` on every program and
  never `write`. Otherwise → 403. `canAccessProgram(...)` returns a boolean. For lists, use
  `programScopeFilter(auth, mode)`, which returns `'ALL' | string[]`.
- **`SessionTokenService`** (auth/users slices; only the SHA-256 of a token is stored):
  - `createSession(tx, { userId, ip?, ua?, ttlHours }): Promise<{ token, sessionId, expiresAt }>` —
    a session **without** MFA. `ttlHoursFor(roles)` picks the admin TTL (12 h) or the member TTL
    (168 h).
  - `elevateSession(tx, oldSessionId, method: 'EMAIL_OTP' | 'TOTP'): Promise<{ token, sessionId, expiresAt }>`
    — call it in the transaction that accepts the second factor. It **rotates** the token: inserts a
    new session row (`mfaVerifiedAt = now`, `mfaMethod`, same ip/ua,
    `expiresAt = least(old.expiresAt, now + 12 h)`) and revokes the old row with `mfa_rotated`
    (conditional UPDATE, so two concurrent elevations cannot both win). Set the returned token as the
    new cookie. 401 if the old session is revoked/expired.
  - `revokeSession(tx, id, reason)`, `revokeAllForUser(tx, userId, reason, { exceptSessionId? })` —
    call the latter on password change/reset, suspension, deactivation and **any role grant/revoke**.
  - `setSessionCookie(res, token, expiresAt)` / `clearSessionCookie(res)` set the `sid` cookie:
    HttpOnly, SameSite=Lax, `Secure` = `COOKIE_SECURE`, path `/`.
  - `issueCsrfToken(res)` sets a new `csrf_token` cookie (not HttpOnly) and returns the token.
    Call it on login and logout. `clearCsrfCookie(res)` removes it.
- `GET /api/v1/auth/csrf` (public, core-owned `CsrfController`) → `{ data: { csrfToken } }` plus the
  cookie. `@SkipCsrf()` is only for non-cookie callers, such as signed webhooks.

### Crypto (`common/crypto`)

| Helper | Contract |
|---|---|
| `CryptoService` (global) | `encryptOtpCode(code, challengeId): string` / `decryptOtpCode(ciphertext, challengeId): string` (AES-256-GCM, `OTP_OUTBOX_KEY`, AAD = challenge id, base64url); `encryptTotpSecret(base32, userId): Uint8Array` / `decryptTotpSecret(secretEnc, userId): string` (`MFA_ENCRYPTION_KEY`, AAD = `user_mfa_factors:<userId>`); `otpCodeHash(purpose, email, code)`; `emailHmac(email, domain?)`. Decryption failures throw `DecryptionError` |
| `otpCodeHash(pepper, purpose, email, code)` | **The** value for `email_challenges.code_hash`: HMAC-SHA-256(`OTP_PEPPER`, `purpose:email:code`), email trimmed + lower-cased. The OTP worker uses it to detect stale messages, `OtpMailer` refuses codes that do not match it |
| `aesGcmEncrypt/Decrypt(key, data, aad)` | sealed box `[0x01][iv 12][tag 16][ciphertext]`; `…ToString/FromString` = base64url |
| `hmacSha256Hex`, `hexDigestEquals`, `safeEqual` (= `constantTimeEqual`), `sha256Hex`, `randomToken`, `randomNumericCode(6)` | constant-time compares; CSPRNG tokens/codes |
| TOTP (RFC 6238; tested against the RFC 4226/6238 vectors) | `generateTotpSecret()` (160-bit base32), `totp(secret, timeMs?)`, `verifyTotp(secret, code, { lastUsedStep?, now?, window = 1 })` → `{ ok: true, step } \| { ok: false, reason: 'malformed' \| 'invalid' \| 'replayed' }` (SHA-1, 6 digits, 30 s, ±1 step). Persist `step` as `user_mfa_factors.last_used_step` with a conditional UPDATE (`… WHERE last_used_step IS NULL OR last_used_step < $step`) for replay protection. `buildOtpauthUri({ secret, accountName, issuer })` → `otpauth://totp/…` (issuer: `config.security.totpIssuer`) |

### Rate limiting (`common/throttle`)

`@nestjs/throttler` keyed by client IP. `req.ip` honours `X-Forwarded-For` only when
`TRUST_PROXY` is set. There are three throttlers:
- `default` applies to every route. Health checks use `@SkipDefaultThrottle()`.
- `auth` and `otp` are strict and opt-in per route: `@RateLimit('auth')`, `@RateLimit('otp')`, or
  `@RateLimit('otp', { limit: 3, ttl: 60_000 })` to override.

Storage is pluggable. It is in-memory by default. Set `THROTTLE_STORAGE=redis` to use
`RedisThrottlerStorage`, an atomic Lua fixed window shared by API replicas. Any other storage must
implement `ThrottlerStorage`.

**Login backoff — `LoginThrottleService`** (global; business rules §2: no global account lock).
Redis counters per (HMAC(email), IP) and per IP; after `LOGIN_THROTTLE_FREE_ATTEMPTS` (5) failures
for a pair — or 20 for an IP — every further failure blocks for 30 s · 2^k, capped at 15 min;
counters expire after 24 h without failures. IPv6 addresses are bucketed by /64. Unknown emails use
the same counters (the key is the HMAC of whatever was typed). Redis errors fail open (logged).

```ts
const emailKey = loginThrottle.emailKey(dto.email);                 // HMAC(OTP_PEPPER, email)
loginThrottle.assertAllowed(await loginThrottle.check(emailKey, ip)); // 429 RATE_LIMITED, Retry-After
if (!passwordOk) { await loginThrottle.recordFailure(emailKey, ip); throw invalidCredentials(); }
await loginThrottle.reset(emailKey, ip);                            // success: clears the pair only
```
`check(emailHmac, ip): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds; scope: 'account' | 'ip' }>`,
`recordFailure(emailHmac, ip): Promise<{ failures; ipFailures; retryAfterSeconds | null }>`,
`reset(emailHmac, ip): Promise<void>`. A 429 whose `details.retryAfterSeconds` is set gets that
value as `Retry-After`. OTP attempt/send caps remain DB counters on `email_challenges` (auth slice).

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

**Idempotency (`common/idempotency`).** Financial mutations use `@Idempotent()` (global
`IdempotencyInterceptor`, a no-op elsewhere):

```ts
@Post(':id/approve') @Idempotent() @RequirePermissions('rewards:approve')
approve(@Param() p: IdParamDto, @CurrentUser() auth: AuthContext) { ... }
```

The `Idempotency-Key` header (8–128 chars of `[A-Za-z0-9_-:.]`, required by default; `{ required:
false }` makes it optional) is stored in `idempotency_keys` per **actor** for 24 h with the
SHA-256 of the canonical request (`method`, route pattern, params, query, body). A retry with the
same key and request returns the stored status + body (`Idempotent-Replayed: true`) without running
the handler; the same key with another request → 409 `IDEMPOTENCY_CONFLICT`; while the first request
is still running → 409 `CONFLICT` (`details.retryable`). Errors are not stored (the key is
released, so a retry runs again). An IN_PROGRESS key abandoned for > 5 min may be taken over by the
same request. Non-HTTP callers use `IdempotencyService`:
`begin({ actorUserId, key, route, requestHash }) → { state: 'new' } | { state: 'replay', status, body }`,
`complete({ actorUserId, key, status, body })`, `release({ actorUserId, key })`,
`execute(input, fn, status = 200)`, `purgeExpired(now?)`; hash with
`computeRequestHash(value)` (stable JSON → SHA-256 hex). The worker job `idempotency-keys-cleanup`
(hourly) deletes expired keys. The lower-level `@IdempotencyKey({ required })` param decorator only
parses the header.

### Data access (`common/prisma`)

- `PrismaService` extends the generated `PrismaClient` and uses the pg driver adapter.
- `Tx = Prisma.TransactionClient`. `Db` is the same type: use it for helpers that run with or
  without a transaction (`PrismaService` is assignable to it).
- `prisma.runInTransaction(fn, { isolationLevel?, timeout = 15s, maxWait = 5s, retries = 0 })`.
  `retries` re-runs `fn` on serialization failures and deadlocks, so `fn` must be idempotent.
- `createPrismaClient(url)` is a Nest-free client for scripts and tests.
- Write `AuditService.record(tx, …)` and `OutboxService.enqueue(tx, …)` inside the business
  transaction. Never send email inside a DB transaction.
- **No savepoints in referral writes.** The integrity triggers recognise "rows created in this
  transaction" by `xmin`. In Prisma 7 a transaction client also exposes `$transaction`, which opens a
  nested SAVEPOINT — never call `tx.$transaction(...)` inside a registration or correction.
- **Referral write protocol helpers** (`common/prisma/referral-tree-lock.ts`):
  `lockReferralTreeShared(tx)` (registration: after the users INSERT, then self row → relationship
  → ancestor rows), `lockReferralTreeExclusive(tx)` + `setReferralCorrectionId(tx, correctionId)`
  (corrections: lock first, insert the `referral_corrections` row, set the id, then rewrite).
  UPDATE/DELETE on `referral_paths` inside a correction works since migration
  `20261010120000_fix_referral_modify_guard` (the original guard failed with `42703`).
- Revoking any role (`user_roles` UPDATE/DELETE) or deactivating an ACTIVE user runs the deferred
  "≥ 1 ACTIVE SUPER_ADMIN" check at COMMIT.

### Cross-cutting services (global `CommonModule`; no import needed)

| Service | Contract |
|---|---|
| `AuditService.record(db, { action, resourceType, resourceId?, programId?, before?, after?, reason?, actorUserId?, actorRoles? })` | Takes `requestId`/`ip` from the request context and the actor + roles from the `AuthContext`. `actorUserId: null` records a system action with roles `['SYSTEM']`. Set `programId` on program-scoped entries (programs, options, policies, enrollments, events, rewards). `before`/`after` must be an allow-list of changed fields; they are JSON-normalized (bigint → string), keys matching the DB CHECK (`password*`, `token*`, `otp`, `otpCode`, `codeHash`, `secret*`, `sessionToken`, `csrfToken`, `apiKey`, `keyHash`, `codeCiphertext`, plus `*password*`, `*secret*`, `*hash`, `*token`) are removed recursively, `*email` values are masked with `maskEmail` (`a***@e***.com`) and `*phone` with `maskPhone` (`+**********10`). Plain `code` is allowed |
| `OutboxService.enqueue(tx, { topic, payload, dedupeKey?, availableAt?, maxAttempts? })` | Returns `{ id, enqueued }`. A duplicate `dedupeKey` is a no-op (`ON CONFLICT DO NOTHING`) and does not abort the transaction. Topics are typed in `common/outbox/outbox.topics.ts`: `email.send` → `{ to, template, data }` with templates `registration-attempt-existing-account`, `email-changed-notice`, `reward-status`, `enrollment-status`, `generic`; `email.otp` (OtpMailer only); `notification.create` → `{ userId, type, title, body, data? }`. **No key named `code` or `otp` anywhere in a payload** (DB CHECK, mirrored by `assertOutboxPayloadSafe`) — use `programCode`, `referralCode`, … |
| `OtpMailer.enqueue(tx, { challengeId, code, email, purpose }): Promise<{ outboxId }>` | The only way to email a one-time code. Call it in the transaction that wrote the challenge (whose `code_hash` must be `CryptoService.otpCodeHash(purpose, email, code)` — verified). Payload = `{ challengeId, codeCiphertext, template: 'otp' }`, max 6 attempts |
| `CryptoService` | see "Crypto" |
| `IdempotencyService`, `LoginThrottleService` | see "Validation and DTOs" and "Rate limiting" |
| `PlatformSettingsService` | `get(db?)` = the singleton (created with `INSERT … ON CONFLICT DO NOTHING` if missing; 30 s cache without `db` — pass the `tx` when the value drives a write). `update(tx, { expectedVersion, patch: { rewardUnit?, currencyCode?, pointsLabel?, pointsPerCurrencyUnit?, defaultRewardBudgetBps? }, actorUserId })` → `{ before, after }`: conditional on `version` (else 409 `STALE_VERSION`), never writes `version` (the trigger bumps it once), takes `currencyMinorUnits` from `currencies`; currency changes blocked by the DB while live programs use another currency (409 `INVARIANT_VIOLATION`). Audit in the same tx, `invalidate()` after commit. Helpers: `toAmountFormat(settings)` (only for things without a stored unit), `toRecordAmountFormat({ rewardUnit, currencyCode, currencyMinorUnits \| minorUnits }, pointsLabel)` (from a record's own snapshot), `toCurrencyFormat(settings)`, `programSnapshotFrom(settings)`, `policyDefaultsFrom(settings)` |
| `SessionTokenService`, `SessionAuthService` | see above |
| `RedisService` | lazy shared ioredis client (`redis`, `ping()`) |
| `RequestContext` | `requestId`, `ip`, `userAgent`, `auth`; `RequestContext.run({...}, fn)` for jobs |

Logging: inject the Nest `Logger` (`new Logger(Ctx.name)`). nestjs-pino is the app logger, writes
JSON (pretty only on a dev TTY), and adds `requestId` to every request-scoped line. These are
redacted: `authorization`, `cookie`, `x-csrf-token` and `set-cookie` headers, plus `password*`,
`code*`, `otp`, `token*`, `csrfToken`, `secret*`, `codeCiphertext`, `apiKey`, `keyHash` keys up to 4
levels deep. URLs are logged without query strings. Never log OTPs, tokens or full email addresses
(use `maskEmail()` from `common`).

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
  - `DEAD` once `attempts >= max_attempts` (8 by default) or on `PermanentOutboxError`.

  The UPDATE that marks a row `SENT` or `DEAD` also runs `payload = payload - ARRAY['codeCiphertext',
  …scrubKeys]` (DB CHECK: no ciphertext on SENT/DEAD rows). `last_error` is the error name + message
  with every payload string value redacted. Delivery is at least once, so handlers must be
  idempotent. No BullMQ job ever carries a payload (the relay polls the table).
- **`email.otp`** (`OtpEmailOutboxHandler`): loads the challenge; skips (→ SENT, scrubbed) when it is
  gone, consumed, invalidated, expired, or when the decrypted code no longer matches `code_hash`
  (re-issued); a ciphertext that fails to decrypt is permanent (→ DEAD, scrubbed); otherwise sends
  the purpose-specific OTP email to the challenge address. SMTP errors are reduced to
  `SMTP delivery failed (<code> <status>)` (no addresses). The `outbox-otp-expiry` job (every 15
  min) gives up undelivered OTP messages older than an hour (DEAD, scrubbed).
- **`notification.create`**: inserts with `source_key = <outbox message id>` and
  `ON CONFLICT DO NOTHING`, so redelivery never duplicates.
- **Registering an outbox handler:** in a provider of your module,
  `constructor(r: OutboxHandlerRegistry) { r.register('topic', { handle, scrubKeys? }) }`. New topics
  must be added to `outbox.topics.ts`; coordinate this.
- **Email:** `EmailService` sends over nodemailer SMTP (Mailpit in dev). Templates in
  `jobs/email/templates.ts` are pure functions that return `{ subject, text, html }` with HTML
  escaped. The OTP template (`renderOtpEmail`) is used only by the `email.otp` handler. Amounts
  arrive pre-formatted (`amountFormatted`).
- **Scheduled jobs:** `ScheduledJobsRegistry.register({ name, everyMs | cron, tz?, handler })` from
  a provider in your module. They are installed as BullMQ job schedulers on queue `scheduled-jobs`;
  stale schedulers are removed and one run happens at a time. Handlers must be idempotent.
  `registry.runNow(name)` runs a job directly, for example in tests. Core registers
  `outbox-cleanup` (03:17 daily; deletes `SENT` rows older than 14 days), `outbox-otp-expiry`
  (every 15 min) and `idempotency-keys-cleanup` (hourly). Feature modules register
  `auth-challenge-cleanup` (every 15 min), `auth-session-cleanup` (03:41 daily),
  `programs-status-transitions` (every 60 s), `enrollments-expiry` (every 5 min) and
  `events-received-sweeper` (every 60 s).
- **Outbox topics** (`common/outbox/outbox.topics.ts`): `email.send`, `email.otp`,
  `notification.create` (core handlers in `src/jobs`) and `fraud.registration-attributed`
  (handled by `FraudSignalsService` in the referrals module).

### Cross-module contracts

All contracts are implemented; the signatures and semantics are listed in
[Module map → Cross-module contracts](#module-map). Rules that keep them safe:

- Contracts that take a `tx` run inside the caller's transaction and must not open their own
  (no `tx.$transaction`, which would create a savepoint). `RewardEngineService.processEvent`
  is the exception: it opens its own transaction, so call it after the caller has committed.
- `LedgerService.postReward` / `reverseReward` change the reward status themselves; callers only
  move PENDING_APPROVAL → APPROVED before posting.
- Module imports follow the dependency direction in the module map: referrals, enrollments,
  ledger, notifications, reconciliation and audit never import rewards or events, so there are no
  cycles and no `forwardRef`.

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
  against real Postgres, Redis and Mailpit. It runs one file at a time in one worker. `globalSetup`
  creates the database named in `TEST_DATABASE_URL` if it is missing and runs `prisma migrate
  deploy`. The database name must contain `test`; this guards against truncating dev data.
- **A dedicated database per slice** avoids clashes between slices that run in parallel (the core
  uses `referral_test_core`):
  ```bash
  TEST_DATABASE_URL=postgresql://referral:referral_dev_password@localhost:5432/referral_test_auth?schema=public \
    corepack pnpm --filter @app/api exec vitest run --config vitest.integration.config.ts test/auth
  ```
- `test/utils/db.ts`:
  - `testPrisma()` is a shared client for `TEST_DATABASE_URL`.
  - `resetDatabase()` runs TRUNCATE on every table except `_prisma_migrations` and `currencies`
    (migration-seeded reference data) with `RESTART IDENTITY CASCADE`, then re-seeds roles,
    permissions and settings.
  - `disconnectTestPrisma()`.
- `test/utils/app.ts`:
  - `createTestApp({ env?, imports? })` builds the full `AppModule` with the same `configureApp()`
    as `main.ts`, with silent logs (`TEST_LOG_LEVEL=debug` to see them), no in-process worker and
    very high rate limits (override via `env`).
  - It returns `{ app, config, prisma, server, client(), clientWithSession(token), get(Token), close() }`.
  - `TestClient` sends its cookie jar on every request and adds a matching `csrf_token` cookie and
    `x-csrf-token` header to mutations. `.withoutCsrf()` and `.withHeaders({...})` adjust that.
- `test/utils/factories.ts` — every factory satisfies the DB triggers and is **now-relative** (the
  DB refuses back-dated policies, coverage and sales outside the program period). Each accepts the
  root client (it opens its own transaction) or a transaction client (never one with savepoints):
  - `createUser(db, { sponsor?, roles?, status?, verified?, password?, programScopes?, referralCode?, createdAt? })`
    — one transaction per the registration protocol (user → shared tree lock → self row →
    relationship through the sponsor's active code → ancestor rows → own referral code → roles).
    The sponsor must be ACTIVE + verified.
  - `factoryAdmin(db)` — a SUPER_ADMIN (`factory-admin@example.test`, no sponsor/downline) used as
    approver/publisher/recorder; created on first use after each reset. Revoking a role in a test
    needs an ACTIVE SUPER_ADMIN to exist (call it first).
  - `loginAs(t, user, { mfa?: 'NONE' | 'EMAIL_OTP' | 'TOTP', mfaVerifiedAt?, ttlHours? })` — creates
    the session directly (MFA via `elevateSession`); default `TOTP` for admins, `NONE` for members.
    `createTotpFactor(t, user, { confirmed? })` → `{ factorId, secret }`.
  - `createOffering(db, { status = 'ACTIVE' })` (ACTIVE ones are approved by the factory admin).
  - `createProgram(db, { status, currencyCode, rewardUnit, options[], … })` — inserted DRAFT with the
    currency snapshot, options added, then walked through the lifecycle (published by the factory
    admin). Default: started 30 days ago, open enrollment, one free option.
  - `createPolicy(db, { programId, status = 'PUBLISHED', rules, effectiveFrom = now − 30 s, publishedById?, closeCurrent? })`.
  - `createEnrollment(db, { userId, programId, status = 'ACTIVE' | 'PENDING' | 'CANCELLED' | 'REJECTED', … })`
    — program must be ACTIVE with an open window; paid options are activated with a payment record;
    coverage starts now (EXPIRED cannot be fabricated).
  - `createEvent(db, { programId, subjectUserId, source = 'ADMIN_MANUAL', amountMinor, … })` (recorded by
    the factory admin; API/WEBHOOK get an api client), `createApiClient(db, programId)`.
  - `processEventForTest(db, { eventId, policyVersionId, rewards[] })` (engine stand-in: binds the
    policy, writes the calculation snapshot and rewards, marks PROCESSED) and
    `postRewardForTest(db, rewardId, approverId)` (ledger stand-in: approve + exact two-entry posting).
- `test/utils/probe.module.ts` mounts test-only controllers (`createTestApp({ imports: [ProbeModule] })`):
  idempotent routes, trigger-error probes (`/__probe/invariant/{immediate,check,deferred}`), etc.
- Core suites: `health`, `session-auth` (MFA/adminAccess, `elevateSession`, per-request
  permissions), `csrf`, `throttle` (Nest throttler + `LoginThrottleService` on Redis),
  `idempotency`, `core-services` (outbox relay, OTP delivery via Mailpit + scrubbing, notifications,
  audit, settings, seed) and `db-invariants` (factory-level invariants, the raw-SQL happy path and 28
  attack scenarios that must fail with 23001/23514/23505/23P01, and the HTTP 409 mapping).
