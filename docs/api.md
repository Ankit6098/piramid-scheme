# API

REST/JSON API served by `apps/api` (NestJS). In production nginx serves it on the same origin as
the web app (`https://<host>/api/v1/...`). In development it runs on `http://localhost:4000`, and the
web dev server rewrites `/api/*` to it.

This page is the **index**: the conventions every endpoint follows, then a catalogue of every
implemented route. Request and response contracts, rules and error cases are in the slice
documents:

| Slice doc | Covers |
|---|---|
| [api/identity.md](api/identity.md) | Registration, email verification, login, logout, password reset, admin MFA (email OTP + TOTP), self-service account (`/users/me`) |
| [api/catalog.md](api/catalog.md) | Platform settings and currencies, offerings, programs and options, program admins, member program catalogue, enrollments |
| [api/network.md](api/network.md) | Referral codes, sponsor/upline, team tree, admin hierarchy views, sponsor corrections, member flags, the shared-IP fraud signal |
| [api/engine.md](api/engine.md) | Reward policies (drafts, validation, dry-run, publish, retire), sales intake and events, API clients and machine ingestion |
| [api/finance.md](api/finance.md) | Reward queue, approve/reject/reverse, event reversal, ledger, reconciliation, member rewards and earnings, CSV exports |
| [api/adminops.md](api/adminops.md) | Admin overview, member administration (suspend, roles), audit log, notifications, member dashboard |

Other sources of truth:

- **Contracts:** Zod request schemas and response DTO types live in `@app/shared`
  (`packages/shared/src/contracts/<module>.ts`). The API wraps them with `createZodDto`; the web
  app imports the same types.
- **OpenAPI / Swagger UI:** `/api/docs` (JSON at `/api/docs-json`), disabled when
  `NODE_ENV=production`. Export the spec with `corepack pnpm --filter @app/api openapi`.
- **Domain rules:** [business-rules.md](business-rules.md). **Security model:** [security.md](security.md).

## Contents

1. [Conventions](#conventions)
2. [Endpoint catalogue](#endpoint-catalogue)
3. [Documented vs implemented](#documented-vs-implemented)
4. [Adding an endpoint](#adding-an-endpoint)

## Conventions

### Paths and versioning

- Base path `/api/v1` (global prefix `api` + URI versioning). A breaking change would ship as
  `/api/v2`, with both versions served during a migration window.
- Member routes: `/api/v1/<module>/...`; the caller's own resources live under `/users/me/...`.
- Admin routes: `/api/v1/admin/...`. Every one of them requires an admin role **and** a
  TOTP-verified session (see [Admin access](#admin-access-and-mfa)), plus the route's permission.
- JSON properties are `camelCase`. Path segments are kebab-case plural nouns. Non-CRUD actions are
  POST sub-resources (`POST /admin/rewards/{id}/approve`, `POST /admin/programs/{id}/publish`).
- Status codes: `200` (also for actions), `201` with the created resource, `202` for "accepted,
  check your email" flows, `204` for deletes with no body. ETags are disabled.

### Envelopes

```jsonc
// Single resource
{ "data": { "id": "…", "status": "ACTIVE" } }

// List (cursor pagination)
{ "data": [ { … } ], "page": { "nextCursor": "eyJjcmVhdGVkQXQiOi…", "limit": 25 } }

// Error
{ "error": { "code": "VALIDATION_FAILED", "message": "The request is invalid",
             "details": { "issues": [ { "path": "email", "message": "Invalid email", "code": "invalid_format" } ] },
             "requestId": "5e4f8cb6dd275d2118b9710508dcb6d9" } }
```

- Every response body is an explicit DTO, never a Prisma entity. `passwordHash`, `codeHash`,
  `tokenHash`, TOTP secrets (after enrollment), API keys (after creation) and other members'
  email addresses or phone numbers are never returned.
- CSV exports are the only non-JSON success responses (see [CSV exports](#csv-exports)).

### Errors

`code` comes from `ErrorCode` in `@app/shared`. `message` is safe to show to users. `details` is
structured and never contains secrets.

| Status | Codes |
|---|---|
| 400 | `VALIDATION_FAILED` (`details.issues[] = { path, message, code }`), `POLICY_INVALID` (`details.issues`), `REFERRAL_CODE_INVALID`, `OTP_INVALID` (every failed code verification, same message) |
| 401 | `UNAUTHENTICATED` (no/expired/revoked session, bad API key), `INVALID_CREDENTIALS` |
| 403 | `FORBIDDEN` (`details.missingPermissions` when a permission is missing; program outside the caller's scope), `MFA_REQUIRED` (`details.reason`), `CSRF_FAILED`, `ACCOUNT_SUSPENDED`, `EMAIL_NOT_VERIFIED` |
| 404 | `NOT_FOUND`. Also used instead of 403 where existence must not leak (another member's reward, a member outside the visible team, a member outside a program admin's scope) |
| 409 | `CONFLICT` (unique violations; `details.reason` such as `SEGREGATION_OF_DUTIES`, `RECORDER_SOD`, `STALE_SUPERSEDE`; `details.retryable` for serialization failures and in-flight idempotency keys), `INVARIANT_VIOLATION` (a DB trigger refused the write), `REFERRAL_CYCLE`, `PROGRAM_NOT_ENROLLABLE`, `ALREADY_ENROLLED`, `NOT_ELIGIBLE`, `INVALID_STATE_TRANSITION` (`details.status` / `details.checks` / `details.fields`), `STALE_VERSION`, `IDEMPOTENCY_CONFLICT` |
| 413 | `PAYLOAD_TOO_LARGE` (API body limit 100 kB; nginx limit 2 MB) |
| 429 | `RATE_LIMITED`, `OTP_TOO_MANY_ATTEMPTS`, `OTP_COOLDOWN` (with `Retry-After` when known) |
| 500 | `INTERNAL_ERROR` (generic message; correlate with `requestId`) |
| 501 | `NOT_IMPLEMENTED` |
| 503 | `SERVICE_UNAVAILABLE` (readiness failure, or nginx when the API is unreachable) |

`ACCOUNT_LOCKED` (423) and `OTP_EXPIRED` exist in the enum but no route emits them: login uses
throttling instead of account locks, and an expired code is reported as `OTP_INVALID`.

Database guards: trigger violations (SQLSTATE `23001`), CHECK violations (`23514`) and exclusion
violations (`23P01`) become `409 INVARIANT_VIOLATION` with `details = { sqlState, constraint?,
reason? }`; unique violations become `409 CONFLICT` (or a domain code such as `ALREADY_ENROLLED`).
Services validate first, so these mostly indicate a race or a bug. See
[database.md](database.md#invariants).

### Pagination, filtering, sorting

- Query: `?cursor=<opaque>&limit=<1..100>` (default 25 unless a route says otherwise; team children
  default 50, team search ≤ 50). The cursor is base64url JSON of the sort key. Treat it as opaque. A
  tampered cursor → `400 VALIDATION_FAILED`.
- `nextCursor: null` means the last page. Large lists carry no total counts; dedicated endpoints
  return counts (`/admin/rewards/counts`, `/users/me/hierarchy/summary`, `/admin/overview`).
- Filters are plain query parameters (`?status=PENDING_APPROVAL&programId=…`); some accept a
  repeated parameter (`status=ACTIVE&status=PAUSED`). The default sort is newest first
  (`createdAt desc, id desc`) unless the slice doc says otherwise.
- Date filters (`from` / `to`) accept an ISO-8601 date-time with offset, or a calendar date
  `YYYY-MM-DD` (UTC day) on finance routes. `from` is inclusive, `to` exclusive.

### Data types

| Type | Wire format |
|---|---|
| Amounts (money or points) | **Decimal string of integer minor units**: `"amountMinor": "150000"`. Never a JSON number. Stored as `bigint`. Every amount travels with its own `rewardUnit` + `currencyCode` (+ `currencyMinorUnits` where needed). Format only with `formatAmount()` from `@app/shared`, using the record's own unit and currency, never the live settings. |
| Sale amounts | Always minor units of the **program currency**. Reward amounts are in the program's **reward unit** (currency minor units for MONEY, whole points for POINTS). |
| Rates | Integer basis points: `"budgetBps": 2000` = 20 %, `100` = 1 %. |
| Timestamps | ISO-8601 UTC (`"2026-10-09T19:45:53.123Z"`). Programs carry an IANA `timezone` for display; member reward dates are calendar dates (`YYYY-MM-DD`) in the program time zone. |
| IDs | UUID strings. Programs also have a slug `code` (`GET /programs/{idOrCode}`). |
| Enums | Upper-snake strings from `@app/shared` (`"PENDING_APPROVAL"`). |

### Authentication and sessions

- **Session cookie** `sid` (opaque 32-byte token, `HttpOnly`, `SameSite=Lax`, `Secure` in
  production). Only its SHA-256 is stored. Browsers send it automatically; clients never handle
  tokens. There is no JWT and nothing in `localStorage`.
- Every route requires a session unless marked `public` (no session) or `optional` (works either
  way). `GET /auth/session` returns the current user, roles, permissions, `adminAccess`,
  `mfaMethod` and `hasTotpFactor`.
- Member sessions last 7 days (idle timeout 12 h); admin-role sessions 12 h. Logout revokes the
  session. Password or email change and a TOTP reset revoke the user's other sessions; password
  reset, suspension and any role change revoke all of them. Roles and permissions are re-read on
  every request.
- **Machine clients** (`POST /integrations/events`) authenticate with
  `Authorization: Bearer rpk_…` (an API key scoped to one program), no cookie and no CSRF.

### Admin access and MFA

- `/api/v1/admin/**` requires a non-MEMBER role (else `403 FORBIDDEN`) and `adminAccess`: a TOTP
  code verified **in this session** within the last 12 h. Otherwise `403 MFA_REQUIRED` with
  `details.reason`:
  - `TOTP_ENROLLMENT_REQUIRED`: the admin has no confirmed authenticator yet;
  - `TOTP_REQUIRED`: an authenticator exists but this session has no recent TOTP verification.
- Login never grants admin access by itself. `POST /auth/login` returns
  `{ mfaRequired: true, method: 'TOTP' | 'TOTP_ENROLLMENT' }` for admin-role users. First login:
  an email code bound to the session (`/auth/mfa/email/*`, grants `EMAIL_OTP`, never admin access)
  → `/auth/mfa/totp/setup` → `/auth/mfa/totp/confirm`. Later logins: `/auth/mfa/totp/verify`.
  Every successful step **rotates** the session cookie. Details:
  [api/identity.md](api/identity.md), [ADR-0009](decisions/0009-totp-admin-mfa-session-rotation.md).
- The member area (`/users/me/*`, `/programs/*`) works for admins without MFA.
- **Permissions:** `@RequirePermissions(...)` requires every listed permission
  (`403 FORBIDDEN`, `details.missingPermissions`). Role → permission mapping: `ROLE_PERMISSIONS` in
  `packages/shared/src/permissions.ts` and [business-rules.md §3](business-rules.md#3-roles-permissions-segregation-of-duties).
- **Program scope:** routes marked *scoped* call `assertProgramAccess`. SUPER_ADMIN sees every
  program; PROGRAM_ADMIN only assigned programs (lists are filtered, an explicit out-of-scope
  `programId` → 403, an out-of-scope member → 404); FINANCE_REVIEWER reads every program and writes
  none.
- Hiding UI is never authorization. The API guard is.

### CSRF and origin checks

- Call `GET /api/v1/auth/csrf` once. It sets the `csrf_token` cookie (readable by the SPA) and
  returns `{ data: { csrfToken } }`. Login, verification and logout issue a fresh token.
- Every POST/PUT/PATCH/DELETE must send the cookie value in `x-csrf-token` (constant-time compare).
  When `Origin` is present it must be an allowed origin (`APP_PUBLIC_URL` + `CORS_ORIGINS`;
  `null` is rejected); otherwise a present `Referer` must be allowed. Failure → `403 CSRF_FAILED`.
- Only `POST /integrations/events` skips CSRF (bearer API key, no cookie).

### Idempotency

Financial mutations accept an **`Idempotency-Key`** header (8–128 chars of `[A-Za-z0-9_-:.]`),
stored in `idempotency_keys` per actor for 24 h with a SHA-256 of the canonical request (method,
route pattern, params, query, body):

- a retry with the same key and the same request returns the stored status and body without
  re-running the handler, with the header `Idempotent-Replayed: true`;
- the same key with a different request → `409 IDEMPOTENCY_CONFLICT`;
- while the first request is still running → `409 CONFLICT` (`details.retryable: true`);
- failed requests are not stored (the key is released, so a retry runs again).

| Key | Routes |
|---|---|
| **Required** (missing → 400) | `POST /admin/rewards/{id}/approve`, `/reject`, `/reverse`, `POST /admin/rewards/bulk-approve`, `POST /admin/events/{id}/reverse` |
| Optional | `POST /admin/events` (record a sale), `POST /admin/policies/{id}/publish`, `/retire`, `POST /admin/members/{id}/sponsor-correction` |

Independently of the header, the domain is idempotent where money is concerned: a sale is unique
on `(offering, externalId, revision)` with a request hash (a replay returns the existing event, a
different payload → `409 IDEMPOTENCY_CONFLICT`); a reward is posted at most once
(`reward-posting:<rewardId>`) and reversed at most once (`reward-reversal:<rewardId>`). See
[ADR-0012](decisions/0012-idempotency-key-storage.md).

### Optimistic concurrency

Editable aggregates return a `version`: platform settings (`PUT /admin/settings` takes
`expectedVersion`) and programs (`PATCH /admin/programs/{id}` takes `expectedVersion`; lifecycle
actions accept it optionally). A stale value → `409 STALE_VERSION`; refetch and retry. Policy
drafts accept `expectedUpdatedAt`.

### Rate limits

| Layer | Limit | Applies to |
|---|---|---|
| nginx `auth_mutations` | 10 req/min per IP, burst 20 | state-changing requests under `/api/v1/auth/` |
| nginx `api_general` | 20 req/s per IP, burst 40 | all of `/api/` |
| API `default` throttler | 300 req/min per IP (`THROTTLE_DEFAULT_*`) | every route except health |
| API `auth` throttler | 10 req/min per IP (`THROTTLE_AUTH_*`) | register, login, password forgot/reset, password change; `POST /referrals/validate` uses it with 20 req/min |
| API `otp` throttler | 5 req/min per IP (`THROTTLE_OTP_*`) | resend, verify-email, all `/auth/mfa/*`, email change, TOTP reset |
| Login backoff (Redis) | after 5 failures per (email, IP) or 20 per IP: 30 s · 2^k, max 15 min | login, password change, TOTP confirm/verify/reset, email-change start |
| One-time code limits (DB) | 60 s resend cooldown, 5 codes/h, ≥ 10 failures/24 h block | per (address, purpose); silent on public flows, explicit on admin email MFA |
| Machine ingestion | 120 req/min per IP | `POST /integrations/events` |

A rejection is `429 { "error": { "code": "RATE_LIMITED", … } }` with `Retry-After` when known.
nginx's own 429/503 bodies use the same envelope. Details: [security.md §5](security.md#5-rate-limits).

### Request ids

Every response carries `X-Request-Id`, and every error body includes `requestId`. Send your own
`X-Request-Id` (8–64 chars of `[A-Za-z0-9._:-]`; anything else is replaced by a generated id) to
correlate client logs with nginx and API logs.

### CSV exports

`GET …/export.csv` routes stream `text/csv; charset=utf-8` with a UTF-8 BOM, CRLF rows, RFC 4180
quoting and `Cache-Control: no-store`. Cells starting with `=`, `+`, `-`, `@`, tab or CR are
prefixed with `'` (CSV-injection safe). Amounts appear as an exact major-unit decimal and as
minor units. Admin exports need `reports:export` plus the read permission and are audited before
the first byte; access and filter errors are normal JSON errors. Details:
[api/finance.md](api/finance.md).

## Endpoint catalogue

Paths are relative to `/api/v1`. **Auth** values:

- `public`: no session; `optional`: session used when present;
- `session`: any signed-in user (own resources only);
- `admin session`: signed-in user holding an admin role, MFA not required (the MFA steps themselves);
- `API key`: `Authorization: Bearer rpk_…`;
- a permission key (`rewards:approve`): an `/admin` route; admin role + TOTP session + that
  permission. *scoped* = program scope applies; *global* = SUPER_ADMIN / FINANCE_REVIEWER only
  (platform-wide data).

### Health and CSRF (core)

| Method | Path | Auth | Description | Doc |
|---|---|---|---|---|
| GET | `/health` | public | Liveness (process up) | [deployment](deployment.md) |
| GET | `/health/ready` | public | Readiness: DB + Redis, `503` when not ready | [deployment](deployment.md) |
| GET | `/auth/csrf` | public | Issue the `csrf_token` cookie, returns `{ csrfToken }` | this page |

### Auth (`auth`)

| Method | Path | Auth | Description | Doc |
|---|---|---|---|---|
| POST | `/auth/register` | public | Start registration (optional `referralCode`). Never creates a user; stores the pending registration on an email challenge and emails a code. Generic `202` | [identity](api/identity.md) |
| POST | `/auth/register/resend` | public | Re-send the verification code (limits are silent). Generic `202` | [identity](api/identity.md) |
| POST | `/auth/verify-email` | public | Verify the code + registration password → create the member, referral attribution, own referral code and a session | [identity](api/identity.md) |
| POST | `/auth/login` | public | Email + password → session. Admin roles get `mfaRequired` + `method` | [identity](api/identity.md) |
| POST | `/auth/logout` | optional | Revoke the current session, clear `sid`, issue a new CSRF token | [identity](api/identity.md) |
| GET | `/auth/session` | optional | Current `SessionUserDto`; `401` when signed out | [identity](api/identity.md) |
| POST | `/auth/password/forgot` | public | Email a reset code (generic `202`; admin roles: no email, SUPER_ADMINs are notified) | [identity](api/identity.md) |
| POST | `/auth/password/reset` | public | Reset with the code; revokes every session; does not sign in | [identity](api/identity.md) |
| POST | `/auth/mfa/email/send` | admin session | Email a `LOGIN_MFA` code bound to this session (admins without an authenticator) | [identity](api/identity.md) |
| POST | `/auth/mfa/email/verify` | admin session | Verify it → session rotated with `EMAIL_OTP` (no admin access) | [identity](api/identity.md) |
| POST | `/auth/mfa/totp/setup` | admin session | Start authenticator enrollment → `otpauthUri` + secret, shown once | [identity](api/identity.md) |
| POST | `/auth/mfa/totp/confirm` | admin session | Confirm the first code → factor confirmed, session rotated with `TOTP` (admin access) | [identity](api/identity.md) |
| POST | `/auth/mfa/totp/verify` | admin session | Authenticator code (replay-safe) → session rotated with `TOTP` | [identity](api/identity.md) |

### Self-service account (`users`)

| Method | Path | Auth | Description | Doc |
|---|---|---|---|---|
| GET | `/users/me` | session | Own profile | [identity](api/identity.md) |
| PATCH | `/users/me` | session | Update name, phone, avatar URL (https only) | [identity](api/identity.md) |
| POST | `/users/me/password` | session | Change password (current required); revokes other sessions | [identity](api/identity.md) |
| POST | `/users/me/email-change` | session | Start an email change (password + code to the new address). Generic `202` | [identity](api/identity.md) |
| POST | `/users/me/email-change/confirm` | session | Confirm with the code; old address notified; other sessions revoked | [identity](api/identity.md) |
| GET | `/users/me/sessions` | session | Open sessions (cursor) | [identity](api/identity.md) |
| DELETE | `/users/me/sessions/{id}` | session | Revoke one of your sessions | [identity](api/identity.md) |
| POST | `/users/me/sessions/revoke-others` | session | Revoke all other sessions | [identity](api/identity.md) |
| GET | `/users/me/activity` | session | Own activity trail (masked IPs, cursor) | [identity](api/identity.md) |
| POST | `/users/me/mfa/totp/reset` | session (admins only) | Remove the authenticator (current code required) to re-enroll | [identity](api/identity.md) |

### Member dashboard and notifications (`admin`, `notifications`)

| Method | Path | Auth | Description | Doc |
|---|---|---|---|---|
| GET | `/users/me/dashboard` | session | Enrollments, team counts, reward buckets, recent activity, announcements | [adminops](api/adminops.md) |
| GET | `/users/me/notifications` | session | In-app notifications (`unread`, cursor) | [adminops](api/adminops.md) |
| GET | `/users/me/notifications/unread-count` | session | `{ count }` | [adminops](api/adminops.md) |
| POST | `/users/me/notifications/{id}/read` | session | Mark one read (idempotent) | [adminops](api/adminops.md) |
| POST | `/users/me/notifications/read-all` | session | Mark all read | [adminops](api/adminops.md) |

### Settings (`settings`)

| Method | Path | Auth | Description | Doc |
|---|---|---|---|---|
| GET | `/settings/public` | public | Reward unit, currency + minor units, points label (for formatting) | [catalog](api/catalog.md) |
| GET | `/admin/settings` | `settings:write` | Full platform settings with `version` and live-program currencies | [catalog](api/catalog.md) |
| PUT | `/admin/settings` | `settings:write` | Update (`expectedVersion`, `reason`); currency change blocked while live programs use another | [catalog](api/catalog.md) |
| GET | `/admin/currencies` | `settings:write` | Supported currencies with minor units | [catalog](api/catalog.md) |

### Offerings (`offerings`)

| Method | Path | Auth | Description | Doc |
|---|---|---|---|---|
| GET | `/admin/offerings` | `programs:read` | List / filter (status, kind, name/SKU) | [catalog](api/catalog.md) |
| GET | `/admin/offerings/{id}` | `programs:read` | Detail with program counts | [catalog](api/catalog.md) |
| POST | `/admin/offerings` | `offerings:write` | Create (starts INACTIVE) | [catalog](api/catalog.md) |
| PATCH | `/admin/offerings/{id}` | `offerings:write` (+ `offerings:approve` when ACTIVE) | Edit | [catalog](api/catalog.md) |
| DELETE | `/admin/offerings/{id}` | `offerings:write` | Delete an unused INACTIVE offering | [catalog](api/catalog.md) |
| POST | `/admin/offerings/{id}/approve` | `offerings:approve` | Approve → ACTIVE (approver recorded) | [catalog](api/catalog.md) |
| POST | `/admin/offerings/{id}/deactivate` | `offerings:approve` | Deactivate with a reason | [catalog](api/catalog.md) |

### Programs and options (`programs`)

| Method | Path | Auth | Description | Doc |
|---|---|---|---|---|
| GET | `/programs` | session | Enrollable / visible programs with active options and my eligibility | [catalog](api/catalog.md) |
| GET | `/programs/{idOrCode}` | session | Program detail with terms | [catalog](api/catalog.md) |
| GET | `/admin/programs` | `programs:read` *scoped* | List / filter | [catalog](api/catalog.md) |
| POST | `/admin/programs` | `programs:write` | Create DRAFT (snapshots unit, currency, minor units) | [catalog](api/catalog.md) |
| GET | `/admin/programs/{id}` | `programs:read` *scoped* | Detail: options, policy summary, status history, publish checks, allowed actions | [catalog](api/catalog.md) |
| PATCH | `/admin/programs/{id}` | `programs:write` *scoped* | Edit (`expectedVersion`; editable fields depend on status) | [catalog](api/catalog.md) |
| DELETE | `/admin/programs/{id}` | `programs:write` *scoped* | Delete a DRAFT | [catalog](api/catalog.md) |
| POST | `/admin/programs/{id}/publish` | `programs:publish` *scoped* | DRAFT → SCHEDULED / ACTIVE (preconditions checked) | [catalog](api/catalog.md) |
| POST | `/admin/programs/{id}/pause` | `programs:publish` *scoped* | ACTIVE → PAUSED (reason required) | [catalog](api/catalog.md) |
| POST | `/admin/programs/{id}/resume` | `programs:publish` *scoped* | PAUSED → ACTIVE | [catalog](api/catalog.md) |
| POST | `/admin/programs/{id}/complete` | `programs:publish` *scoped* | ACTIVE / PAUSED → COMPLETED | [catalog](api/catalog.md) |
| POST | `/admin/programs/{id}/archive` | `programs:publish` *scoped* | COMPLETED → ARCHIVED | [catalog](api/catalog.md) |
| POST | `/admin/programs/{id}/cancel` | `programs:publish` *scoped* | Withdraw a SCHEDULED program before its start → ARCHIVED (reason required) | [catalog](api/catalog.md) |
| POST | `/admin/programs/{id}/options` | `programs:write` *scoped* | Add a plan (price in program currency) | [catalog](api/catalog.md) |
| PATCH | `/admin/programs/{id}/options/{optionId}` | `programs:write` *scoped* | Edit a plan (terms frozen once it has enrollments) | [catalog](api/catalog.md) |
| POST | `/admin/programs/{id}/options/{optionId}/deactivate` | `programs:write` *scoped* | Deactivate a plan | [catalog](api/catalog.md) |
| POST | `/admin/programs/{id}/options/{optionId}/activate` | `programs:write` *scoped* | Re-activate a plan | [catalog](api/catalog.md) |
| GET | `/admin/programs/{id}/admins` | `programs:read` *scoped* | Assigned program admins | [catalog](api/catalog.md) |
| GET | `/admin/programs/{id}/admins/candidates` | `roles:assign` | Active PROGRAM_ADMIN users | [catalog](api/catalog.md) |
| PUT | `/admin/programs/{id}/admins` | `roles:assign` | Replace the assigned admins | [catalog](api/catalog.md) |

### Enrollments (`enrollments`)

| Method | Path | Auth | Description | Doc |
|---|---|---|---|---|
| POST | `/programs/{id}/enrollments` | session | Enroll with a plan (free → ACTIVE, paid → PENDING) | [catalog](api/catalog.md) |
| GET | `/users/me/enrollments` | session | Own enrollments | [catalog](api/catalog.md) |
| POST | `/users/me/enrollments/{id}/cancel` | session | Cancel own enrollment | [catalog](api/catalog.md) |
| GET | `/admin/enrollments` | `enrollments:manage` *scoped* | Queue / list (status, program, member, payment ref) | [catalog](api/catalog.md) |
| GET | `/admin/enrollments/{id}` | `enrollments:manage` *scoped* | Detail | [catalog](api/catalog.md) |
| POST | `/admin/enrollments/{id}/activate` | `enrollments:manage` *scoped* | Record the offline payment → ACTIVE | [catalog](api/catalog.md) |
| POST | `/admin/enrollments/{id}/reject` | `enrollments:manage` *scoped* | Reject a PENDING enrollment (reason) | [catalog](api/catalog.md) |
| POST | `/admin/enrollments/{id}/cancel` | `enrollments:manage` *scoped* | Cancel (reason) | [catalog](api/catalog.md) |

### Referral network (`referrals`)

| Method | Path | Auth | Description | Doc |
|---|---|---|---|---|
| POST | `/referrals/validate` | public | Check a referral code for the registration form → `{ valid, sponsorDisplayName? }` | [network](api/network.md) |
| GET | `/users/me/referral-code` | session | Own code + share link | [network](api/network.md) |
| GET | `/users/me/parent` | session | Sponsor and ancestors (display names only, ≤ 10) | [network](api/network.md) |
| GET | `/users/me/referrals` | session | Direct referrals (cursor) | [network](api/network.md) |
| GET | `/users/me/hierarchy/summary` | session | Team counts per depth (≤ 10), active / eligible counts | [network](api/network.md) |
| GET | `/users/me/hierarchy/tree` | session | Lazily loaded team tree (`rootId`, `depth` 1..3) | [network](api/network.md) |
| GET | `/users/me/hierarchy/children` | session | Children of a node (cursor) | [network](api/network.md) |
| GET | `/users/me/hierarchy/path/{memberId}` | session | Path from me down to a team member | [network](api/network.md) |
| GET | `/users/me/hierarchy/search` | session | Search the team by display name | [network](api/network.md) |
| GET | `/admin/members/{id}/hierarchy` | `members:read` *scoped* | Admin tree view (no depth limit) | [network](api/network.md) |
| GET | `/admin/members/{id}/hierarchy/summary` | `members:read` *scoped* | Whole-subtree counts | [network](api/network.md) |
| GET | `/admin/members/{id}/hierarchy/children` | `members:read` *scoped* | Children of a node | [network](api/network.md) |
| GET | `/admin/members/{id}/hierarchy/path/{memberId}` | `members:read` *scoped* | Path inside the subtree | [network](api/network.md) |
| GET | `/admin/members/{id}/hierarchy/search` | `members:read` *scoped* | Search the subtree (full name) | [network](api/network.md) |
| GET | `/admin/members/{id}/ancestors` | `members:read` *scoped* | Full upline with attribution source | [network](api/network.md) |
| GET | `/admin/members/{id}/sponsor-correction/preview` | `referrals:correct` | Preview a sponsor move: affected members, issues, `canApply` | [network](api/network.md) |
| POST | `/admin/members/{id}/sponsor-correction` | `referrals:correct` | Apply the correction (reason; optional `Idempotency-Key`) | [network](api/network.md) |
| GET | `/admin/flags` | `flags:manage` | Member flags (status, kind, member) | [network](api/network.md) |
| GET | `/admin/flags/{id}` | `flags:manage` | Flag detail | [network](api/network.md) |
| POST | `/admin/flags` | `flags:manage` | Raise a manual flag | [network](api/network.md) |
| POST | `/admin/flags/{id}/resolve` | `flags:manage` | Resolve or dismiss (`status`, resolution note) | [network](api/network.md) |

### Reward policies (`policies`)

| Method | Path | Auth | Description | Doc |
|---|---|---|---|---|
| GET | `/programs/{id}/policy` | session | Member view of the policy in effect (or next scheduled) | [engine](api/engine.md) |
| GET | `/admin/programs/{id}/policy-context` | `programs:read` *scoped* | Program snapshot, draft defaults, hard cap, current / next version ids | [engine](api/engine.md) |
| GET | `/admin/programs/{id}/policies` | `programs:read` *scoped* | Policy versions of a program | [engine](api/engine.md) |
| POST | `/admin/programs/{id}/policies` | `policies:write` *scoped* | Create a DRAFT (optionally cloned) | [engine](api/engine.md) |
| GET | `/admin/policies/{id}` | `programs:read` *scoped* | Version detail with rules | [engine](api/engine.md) |
| PATCH | `/admin/policies/{id}` | `policies:write` *scoped* | Edit a DRAFT (rules replaced atomically) | [engine](api/engine.md) |
| DELETE | `/admin/policies/{id}` | `policies:write` *scoped* | Delete a DRAFT | [engine](api/engine.md) |
| POST | `/admin/policies/{id}/validate` | `policies:write` *scoped* | Validation issues (+ timeline checks for an `effectiveFrom`) | [engine](api/engine.md) |
| POST | `/admin/policies/{id}/dry-run` | `policies:write` *scoped* | Pure calculation preview (synthetic chain or a real member's upline) | [engine](api/engine.md) |
| POST | `/admin/policies/{id}/publish` | `policies:publish` *scoped* (+ `policies:auto-approve` for auto-approving versions) | Publish at `effectiveFrom`, closing the open version (optional `Idempotency-Key`) | [engine](api/engine.md) |
| POST | `/admin/policies/{id}/retire` | `policies:publish` *scoped* | Retire / withdraw (reason; optional `Idempotency-Key`) | [engine](api/engine.md) |

### Sales intake and events (`events`, `rewards`)

| Method | Path | Auth | Description | Doc |
|---|---|---|---|---|
| GET | `/admin/events/programs` | `programs:read` *scoped* | Programs the caller can view, with `canRecordSales` | [engine](api/engine.md) |
| GET | `/admin/events` | `rewards:read` *scoped* | Sales list / filter | [engine](api/engine.md) |
| GET | `/admin/events/{id}` | `rewards:read` *scoped* | Sale detail: calculation trace, rewards, revisions | [engine](api/engine.md) |
| POST | `/admin/events` | `events:write` *scoped* | Record a sale (idempotent on offering + external id + revision; optional `Idempotency-Key`) → engine runs after commit | [engine](api/engine.md) |
| POST | `/admin/events/{id}/reverse` | `events:reverse` *scoped* | Refund / chargeback: reject live rewards, reverse posted ones (**`Idempotency-Key` required**) | [finance](api/finance.md) |

### Integrations (`integrations`)

| Method | Path | Auth | Description | Doc |
|---|---|---|---|---|
| GET | `/admin/integrations/clients` | `integrations:manage` | API clients (program, status) | [engine](api/engine.md) |
| POST | `/admin/integrations/clients` | `integrations:manage` | Create a client for one program → the key, shown once | [engine](api/engine.md) |
| POST | `/admin/integrations/clients/{id}/revoke` | `integrations:manage` | Revoke a client | [engine](api/engine.md) |
| POST | `/integrations/events` | API key | Machine sale ingestion (same intake as the admin route; minimal response; no CSRF; 120/min per IP) | [engine](api/engine.md) |

### Rewards (`rewards`)

| Method | Path | Auth | Description | Doc |
|---|---|---|---|---|
| GET | `/admin/rewards` | `rewards:read` *scoped* | Reward queue / list with SoD hints | [finance](api/finance.md) |
| GET | `/admin/rewards/counts` | `rewards:read` *scoped* | Counts per status for the current filters | [finance](api/finance.md) |
| GET | `/admin/rewards/facets` | `rewards:read` *scoped* | Programs that have rewards (filter options) | [finance](api/finance.md) |
| GET | `/admin/rewards/export.csv` | `reports:export` + `rewards:read` *scoped* | CSV export (audited) | [finance](api/finance.md) |
| GET | `/admin/rewards/{id}` | `rewards:read` *scoped* | Detail: readable trace, siblings, ledger transactions, audit trail | [finance](api/finance.md) |
| POST | `/admin/rewards/{id}/approve` | `rewards:approve` *scoped* | Approve + post in one transaction (**`Idempotency-Key` required**) | [finance](api/finance.md) |
| POST | `/admin/rewards/{id}/reject` | `rewards:approve` *scoped* | Reject with a reason (**`Idempotency-Key` required**) | [finance](api/finance.md) |
| POST | `/admin/rewards/{id}/reverse` | `rewards:reverse` *scoped* | Compensating ledger transaction (**`Idempotency-Key` required**) | [finance](api/finance.md) |
| POST | `/admin/rewards/bulk-approve` | `rewards:approve` (scope per item) | Up to 100 approvals, per-item results (**`Idempotency-Key` required**) | [finance](api/finance.md) |
| GET | `/users/me/rewards` | session | Own rewards (§10 fields only) | [finance](api/finance.md) |
| GET | `/users/me/rewards/facets` | session | Programs of own rewards | [finance](api/finance.md) |
| GET | `/users/me/rewards/export.csv` | session | CSV of own rewards | [finance](api/finance.md) |
| GET | `/users/me/rewards/{id}` | session | One own reward (`404` for anyone else's) | [finance](api/finance.md) |
| GET | `/users/me/earnings` | session | Earned (from the ledger) / pending / reversed per unit + currency | [finance](api/finance.md) |

### Ledger and reconciliation (`ledger`, `reconciliation`)

| Method | Path | Auth | Description | Doc |
|---|---|---|---|---|
| GET | `/admin/ledger/summary` | `ledger:read` *global* | Totals per unit / currency: posted, reversed, outstanding liability | [finance](api/finance.md) |
| GET | `/admin/ledger/transactions` | `ledger:read` *scoped* (via the reward's program) | Ledger transactions | [finance](api/finance.md) |
| GET | `/admin/ledger/transactions/{id}` | `ledger:read` *scoped* | Transaction with entries | [finance](api/finance.md) |
| GET | `/admin/ledger/accounts` | `ledger:read` *global* | Accounts with balances | [finance](api/finance.md) |
| GET | `/admin/ledger/export.csv` | `reports:export` + `ledger:read` | CSV, one row per entry (audited) | [finance](api/finance.md) |
| GET | `/admin/reconciliation` | `reconciliation:read` *global* | Eight consistency checks + exceptions (`refresh=true` bypasses the 60 s cache) | [finance](api/finance.md) |

### Admin overview, members and audit (`admin`, `audit`)

| Method | Path | Auth | Description | Doc |
|---|---|---|---|---|
| GET | `/admin/overview` | any admin (figures *scoped*) | Dashboard counters, 30-day series, recent actions | [adminops](api/adminops.md) |
| GET | `/admin/members` | `members:read` *scoped* | Search / list members | [adminops](api/adminops.md) |
| GET | `/admin/members/{id}` | `members:read` *scoped* | Profile, roles, sponsor, team counts, enrollments, reward summary | [adminops](api/adminops.md) |
| POST | `/admin/members/{id}/suspend` | `members:write` | Suspend (reason); revokes sessions | [adminops](api/adminops.md) |
| POST | `/admin/members/{id}/reactivate` | `members:write` | Reactivate (reason) | [adminops](api/adminops.md) |
| PUT | `/admin/members/{id}/roles` | `roles:assign` | Replace the role set (reason); revokes sessions | [adminops](api/adminops.md) |
| POST | `/admin/members/{id}/password-reset` | SUPER_ADMIN (`members:write` + `roles:assign`) | Email a reset code, also to admin accounts (reason; not yourself); revokes sessions | [adminops](api/adminops.md) |
| GET | `/admin/audit` | `audit:read` | Audit log (actor, action prefix, resource, program, dates) | [adminops](api/adminops.md) |
| GET | `/admin/audit/{id}` | `audit:read` | Entry with masked before/after and a field-level diff | [adminops](api/adminops.md) |

## Documented vs implemented

The catalogue above (140 routes on 2026-10-10) was checked against every `@Controller` / `@Get` / `@Post` / `@Put` /
`@Patch` / `@Delete` in `apps/api/src` and against the six slice docs. Every implemented route is
documented, and every route in the slice docs exists. Differences from the original plan:

| Planned (earlier skeleton) | Status |
|---|---|
| `POST /users/me/deactivate` (member self-deactivation) | **Not implemented.** `DEACTIVATED` exists in the schema and is honoured everywhere (login, sessions, last-SUPER_ADMIN guard), but no endpoint sets it. |
| `GET /admin/members/{id}/corrections` (correction history) | **Not implemented.** Corrections are append-only rows in `referral_corrections` and appear in the audit log as `referral.correct` (resource `user`); `GET /admin/members/{id}/ancestors` shows the current attribution source. |
| `GET /admin/users/{id}/roles` | Not implemented as a separate route: roles are part of `GET /admin/members/{id}`. Changes go through `PUT /admin/members/{id}/roles`. |
| `GET /admin/reports/{report}.csv` | Replaced by `GET /admin/rewards/export.csv` and `GET /admin/ledger/export.csv` (+ `GET /users/me/rewards/export.csv`). |
| `GET /referrals/codes/{code}` | Implemented as `POST /referrals/validate` (codes stay out of URLs and access logs). |
| `POST /admin/flags/{id}/dismiss` | Merged into `POST /admin/flags/{id}/resolve` with `status: DISMISSED`. |
| `PATCH /admin/settings`, `PUT /admin/policies/{id}` | Implemented as `PUT /admin/settings` and `PATCH /admin/policies/{id}`. |
| `/me/...` member paths | Implemented under `/users/me/...`. |

Code-level note: `EventsController` (`apps/api/src/modules/events/events.controller.ts`,
`@Controller('events')`) is an empty placeholder that registers no routes; all sale routes are in
`AdminEventsController` and `IntegrationsIngestController`.

## Adding an endpoint

1. Add the Zod request schema and response type to `packages/shared/src/contracts/<module>.ts`,
   then `corepack pnpm --filter @app/shared build`.
2. Controller (HTTP only) → service (transaction, audit and outbox inside it) → `domain/` (pure
   rules). Admin routes go in an `@Controller('admin/...')` class, which gets the admin + MFA
   requirement automatically.
3. Guards: `@Public()` only when intended (never on `/admin`); `@RequirePermissions(...)` on admin
   routes; `assertProgramAccess` in the service for program-scoped data; `@Idempotent()` on
   financial mutations; `@RateLimit('auth' | 'otp')` on credential and code routes.
4. Map rows to an explicit DTO with amounts as decimal strings; return `ok()` / `paginate()`.
5. Unit tests for domain rules; an integration test covering the forbidden, out-of-scope and
   invalid cases.
6. Document it in the slice doc (`docs/api/<slice>.md`) and add a row to the catalogue above.
