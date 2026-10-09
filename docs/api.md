# API

REST/JSON API served by `apps/api` (NestJS). In production it is reached on the same origin as the
web app through nginx (`https://<host>/api/v1/...`). In development it runs on `http://localhost:4000`
(and the web dev server rewrites `/api/*` to it).

- **OpenAPI / Swagger UI:** `/api/docs` (disabled when `NODE_ENV=production`). The spec can be
  exported with `corepack pnpm --filter @app/api openapi`.
- **Contracts:** request schemas and response types live in `@app/shared` (`packages/shared/src/contracts/<module>.ts`)
  and are shared by the API (via `createZodDto`) and the web app. They are the source of truth;
  this document summarizes conventions and catalogues endpoints.

## Conventions

### Versioning and paths

- Base path `/api/v1`. Breaking changes → `/api/v2` (both served during a migration window).
- Member-facing routes: `/api/v1/<module>/...`, with "my" resources under `/me` where natural.
- Admin routes: `/api/v1/admin/<module>/...`. They require an admin role **and** an MFA-verified
  session (otherwise `403 MFA_REQUIRED`), plus the route's permission.
- JSON property names are `camelCase`. Path segments are kebab-case plural nouns. Actions that
  are not CRUD are sub-resources with POST (`POST /admin/rewards/{id}/approve`).

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

- Never return Prisma entities. Every response is an explicit DTO. Never expose `passwordHash`,
  `codeHash`, `tokenHash`, or other members' email or phone.
- `204 No Content` for mutations with nothing to return (e.g. logout). Otherwise `200`, or `201`
  with the created resource.

### Pagination, filtering, sorting

- Query: `?cursor=<opaque>&limit=<1..100>` (default 25). The cursor is base64url JSON of the sort
  key. Clients must treat it as opaque. A tampered cursor → `400 VALIDATION_FAILED`.
- `nextCursor: null` means the last page. There are no total counts on large lists (use
  dedicated summary endpoints).
- Filters are plain query parameters (`?status=PENDING_APPROVAL&programId=…`). Each list endpoint
  has a documented default sort, usually `createdAt desc, id desc`.

### Data types

| Type | Wire format |
|---|---|
| Amounts (money or points) | **Decimal string of integer minor units**: `"amountMinor": "150000"`. Never JSON numbers. Accompanied by `rewardUnit` + `currencyCode` where ambiguous. Format with `formatAmount()` from `@app/shared`. |
| Rates | Integer basis points (`"budgetBps": 2000` = 20 %). |
| Timestamps | ISO-8601 with offset, UTC (`"2026-10-09T19:45:53.123Z"`). Programs carry an IANA `timezone` for display. |
| IDs | UUID strings. Programs also have a slug `code`. |
| Enums | Upper-snake strings from `@app/shared` (`"PENDING_APPROVAL"`). |

### Authentication, CSRF, idempotency

- **Session cookie** `sid` (HttpOnly) after login. Browsers send it automatically, so clients
  never handle tokens.
- **CSRF:** call `GET /api/v1/auth/csrf` once. It sets the `csrf_token` cookie. Send its value
  in `x-csrf-token` on every POST/PUT/PATCH/DELETE. The `Origin` header must be an allowed
  origin. Failure → `403 CSRF_FAILED`.
- **Idempotency:** financial mutations (event intake, approvals, reversals, bulk operations)
  accept `Idempotency-Key: <8–128 chars [A-Za-z0-9_-:.]>`. A retried request with the same key
  and the same payload returns the original result. The same key with a different payload →
  `409 IDEMPOTENCY_CONFLICT`.
- **Optimistic concurrency:** editable aggregates (programs, platform settings) return `version`.
  Updates must send it back, and a stale `version` → `409 STALE_VERSION`.

### Errors

`code` values come from `ErrorCode` in `@app/shared`. HTTP status defaults:

| Status | Codes |
|---|---|
| 400 | `VALIDATION_FAILED`, `POLICY_INVALID`, `REFERRAL_CODE_INVALID`, `OTP_INVALID`, `OTP_EXPIRED` |
| 401 | `UNAUTHENTICATED`, `INVALID_CREDENTIALS` |
| 403 | `FORBIDDEN`, `MFA_REQUIRED`, `CSRF_FAILED`, `ACCOUNT_SUSPENDED`, `EMAIL_NOT_VERIFIED` |
| 404 | `NOT_FOUND` (also used instead of 403 where existence must not leak) |
| 409 | `CONFLICT`, `INVARIANT_VIOLATION` (DB guard), `REFERRAL_CYCLE`, `PROGRAM_NOT_ENROLLABLE`, `ALREADY_ENROLLED`, `NOT_ELIGIBLE`, `INVALID_STATE_TRANSITION`, `STALE_VERSION`, `IDEMPOTENCY_CONFLICT` |
| 413 | `PAYLOAD_TOO_LARGE` (nginx limits bodies to 2 MB) |
| 423 | `ACCOUNT_LOCKED` |
| 429 | `RATE_LIMITED`, `OTP_TOO_MANY_ATTEMPTS`, `OTP_COOLDOWN` (with `Retry-After` where known) |
| 500 | `INTERNAL_ERROR` (no internals in `message`; correlate via `requestId`) |
| 501 | `NOT_IMPLEMENTED` |
| 503 | `SERVICE_UNAVAILABLE` (readiness failure, or nginx when the API is unreachable) |

`message` is safe to show to users. `details` is structured (validation `issues`, conflicting ids)
and never contains secrets.

### Rate limits and request ids

- nginx: auth mutations 10/min per IP (burst 20), all API 20 r/s per IP (burst 40). The API adds
  per-route throttles (`auth`, `otp`) and per-account limits. A rejection is
  `429 { "error": { "code": "RATE_LIMITED", … } }`. See [security.md](security.md#5-rate-limits).
- Every response carries `X-Request-Id`, and error bodies include `requestId`. Send your own
  `X-Request-Id` (8–128 chars `[A-Za-z0-9._:-]`) to correlate client logs.

## Endpoint catalogue

This is the skeleton, grouped by module. **Feature slices fill in the request/response contracts
and mark rows as implemented.** Paths are relative to `/api/v1`. "Auth" means: `public`
(no session), `session` (any signed-in user), `member` (signed-in, own resources), or a permission
key (admin, MFA required). Status: `planned` → `implemented`.

### Health

| Method | Path | Auth | Purpose | Status |
|---|---|---|---|---|
| GET | `/health` | public | Liveness (process up) | implemented |
| GET | `/health/ready` | public | Readiness (DB + Redis), 503 when not ready | implemented |

### Auth (`auth`)

| Method | Path | Auth | Purpose | Status |
|---|---|---|---|---|
| GET | `/auth/csrf` | public | Issue `csrf_token` cookie | implemented |
| POST | `/auth/register` | public | Register (optional `referralCode`); generic response | planned |
| POST | `/auth/verify-email` | public | Verify email with OTP | planned |
| POST | `/auth/resend-verification` | public | Resend verification OTP (cooldown) | planned |
| POST | `/auth/login` | public | Email + password → session (admins: `mfaRequired: true`) | planned |
| POST | `/auth/mfa/verify` | session | Verify `LOGIN_MFA` code → `mfaVerified` | planned |
| POST | `/auth/mfa/resend` | session | Resend MFA code | planned |
| POST | `/auth/logout` | session | Revoke current session | planned |
| GET | `/auth/session` | public | Current user, roles, permissions, `mfaVerified` (or `null`) | planned |
| POST | `/auth/password/forgot` | public | Send reset OTP (generic response) | planned |
| POST | `/auth/password/reset` | public | Reset with OTP; revokes all sessions | planned |

### Me / users (`users`)

| Method | Path | Auth | Purpose | Status |
|---|---|---|---|---|
| GET | `/me` | member | Own profile | planned |
| PATCH | `/me` | member | Update name, phone, avatar | planned |
| POST | `/me/password` | member | Change password (current required); revokes other sessions | planned |
| POST | `/me/email-change` | member | Start email change (current password + OTP to new address) | planned |
| POST | `/me/email-change/confirm` | member | Confirm with OTP; notify old address | planned |
| GET | `/me/sessions` | member | Active sessions | planned |
| DELETE | `/me/sessions/{id}` | member | Revoke a session | planned |
| POST | `/me/deactivate` | member | Deactivate own account (terminal) | planned |

### Settings (`settings`)

| Method | Path | Auth | Purpose | Status |
|---|---|---|---|---|
| GET | `/settings/public` | public | Reward unit, currency, points label (for formatting) | planned |
| GET | `/admin/settings` | `settings:write` | Full platform settings | planned |
| PATCH | `/admin/settings` | `settings:write` | Update (with `version`, reason); audited | planned |

### Offerings (`offerings`)

| Method | Path | Auth | Purpose | Status |
|---|---|---|---|---|
| GET | `/admin/offerings` | `programs:read` | List / filter | planned |
| POST | `/admin/offerings` | `offerings:write` | Create | planned |
| GET | `/admin/offerings/{id}` | `programs:read` | Detail | planned |
| PATCH | `/admin/offerings/{id}` | `offerings:write` | Edit / activate / deactivate | planned |

### Programs and options (`programs`)

| Method | Path | Auth | Purpose | Status |
|---|---|---|---|---|
| GET | `/programs` | member | Enrollable / visible programs | planned |
| GET | `/programs/{idOrCode}` | member | Program detail with active options and terms | planned |
| GET | `/admin/programs` | `programs:read` (scoped) | List | planned |
| POST | `/admin/programs` | `programs:write` | Create DRAFT (snapshots unit + currency) | planned |
| GET | `/admin/programs/{id}` | `programs:read` (scoped) | Detail | planned |
| PATCH | `/admin/programs/{id}` | `programs:write` (scoped) | Edit (with `version`) | planned |
| DELETE | `/admin/programs/{id}` | `programs:write` (scoped) | Delete DRAFT only | planned |
| POST | `/admin/programs/{id}/publish` | `programs:publish` (scoped) | DRAFT → SCHEDULED/ACTIVE | planned |
| POST | `/admin/programs/{id}/pause` · `/resume` · `/complete` · `/archive` | `programs:publish` (scoped) | Lifecycle (reason where required) | planned |
| POST | `/admin/programs/{id}/options` | `programs:write` (scoped) | Add option | planned |
| PATCH | `/admin/programs/{id}/options/{optionId}` | `programs:write` (scoped) | Edit wording / deactivate | planned |
| PUT | `/admin/programs/{id}/admins` | `roles:assign` | Assign program admins | planned |

### Reward policies (`policies`)

| Method | Path | Auth | Purpose | Status |
|---|---|---|---|---|
| GET | `/admin/programs/{id}/policies` | `programs:read` (scoped) | Versions | planned |
| POST | `/admin/programs/{id}/policies` | `policies:write` (scoped) | Create DRAFT version (+ rules) | planned |
| GET | `/admin/policies/{policyId}` | `programs:read` (scoped) | Version detail with rules | planned |
| PUT | `/admin/policies/{policyId}` | `policies:write` (scoped) | Replace DRAFT fields and rules | planned |
| DELETE | `/admin/policies/{policyId}` | `policies:write` (scoped) | Delete DRAFT | planned |
| POST | `/admin/policies/{policyId}/dry-run` | `policies:write` (scoped) | Pure calculation preview (sale amount + synthetic chain) | planned |
| POST | `/admin/policies/{policyId}/publish` | `policies:publish` (scoped) | Publish at `effectiveFrom` (closes open version) | planned |
| POST | `/admin/policies/{policyId}/retire` | `policies:publish` (scoped) | Close at now + RETIRED | planned |

### Enrollments (`enrollments`)

| Method | Path | Auth | Purpose | Status |
|---|---|---|---|---|
| POST | `/programs/{id}/enrollments` | member | Enroll with an option (free → ACTIVE, paid → PENDING) | planned |
| GET | `/me/enrollments` | member | Own enrollments | planned |
| POST | `/me/enrollments/{id}/cancel` | member | Cancel | planned |
| GET | `/admin/enrollments` | `enrollments:manage` (scoped) | Queue / list (filter PENDING) | planned |
| POST | `/admin/enrollments/{id}/activate` | `enrollments:manage` (scoped) | Record offline payment → ACTIVE | planned |
| POST | `/admin/enrollments/{id}/reject` | `enrollments:manage` (scoped) | Reject with reason | planned |

### Referrals (`referrals`)

| Method | Path | Auth | Purpose | Status |
|---|---|---|---|---|
| GET | `/referrals/codes/{code}` | public | Validate a code for the registration form (minimal info) | planned |
| GET | `/me/referral` | member | Own code + share link | planned |
| GET | `/me/team/upline` | member | Sponsor and ancestors (privacy-filtered) | planned |
| GET | `/me/team` | member | Descendants ≤ depth 10 (`?depth=`, `?q=`, cursor) | planned |
| GET | `/me/team/summary` | member | Counts per depth, active, enrolled | planned |
| GET | `/admin/members/{id}/team` | `members:read` | Full tree view for admins | planned |
| POST | `/admin/members/{id}/sponsor` | `referrals:correct` | Correction (new sponsor + reason ≥ 10) | planned |
| GET | `/admin/members/{id}/corrections` | `members:read` | Correction history | planned |

### Members and roles (`admin` / `users`)

| Method | Path | Auth | Purpose | Status |
|---|---|---|---|---|
| GET | `/admin/overview` | any admin | Dashboard counters (pending approvals, flags, reconciliation exceptions, dead outbox) | planned |
| GET | `/admin/members` | `members:read` | Search / list | planned |
| GET | `/admin/members/{id}` | `members:read` | Profile, enrollments, rewards summary | planned |
| POST | `/admin/members/{id}/suspend` · `/reactivate` | `members:write` | With reason; revokes sessions on suspend | planned |
| GET | `/admin/users/{id}/roles` | `roles:assign` | Roles of a user | planned |
| PUT | `/admin/users/{id}/roles` | `roles:assign` | Grant / revoke (not self; keep ≥ 1 SUPER_ADMIN) | planned |

### Qualifying events (`events`)

| Method | Path | Auth | Purpose | Status |
|---|---|---|---|---|
| POST | `/admin/events` | `events:write` (scoped) | Record sale (idempotent on `source` + `externalId`; `Idempotency-Key`) | planned |
| GET | `/admin/events` | `rewards:read` / `programs:read` (scoped) | List / filter | planned |
| GET | `/admin/events/{id}` | `rewards:read` (scoped) | Detail with calculation trace and rewards | planned |
| POST | `/admin/events/{id}/reverse` | `events:reverse` | Refund / chargeback (reason) | planned |

### Rewards and earnings (`rewards`)

| Method | Path | Auth | Purpose | Status |
|---|---|---|---|---|
| GET | `/me/rewards` | member | Own rewards (filter by status, program) | planned |
| GET | `/me/earnings` | member | Earned / pending / reversed per unit + currency | planned |
| GET | `/admin/rewards` | `rewards:read` (scoped) | List / approval queue | planned |
| GET | `/admin/rewards/{id}` | `rewards:read` (scoped) | Detail with trace | planned |
| POST | `/admin/rewards/{id}/approve` | `rewards:approve` | Approve + post (not own reward) | planned |
| POST | `/admin/rewards/{id}/reject` | `rewards:approve` | Reject with reason | planned |
| POST | `/admin/rewards/bulk-approve` | `rewards:approve` | Per-item results | planned |
| POST | `/admin/rewards/{id}/reverse` | `rewards:reverse` | Compensating ledger transaction (reason) | planned |

### Ledger and reconciliation (`ledger`, `reconciliation`)

| Method | Path | Auth | Purpose | Status |
|---|---|---|---|---|
| GET | `/admin/ledger/transactions` | `ledger:read` | Transactions with entries | planned |
| GET | `/admin/ledger/accounts` | `ledger:read` | Accounts with balances | planned |
| GET | `/admin/reconciliation` | `reconciliation:read` | Exceptions report | planned |
| GET | `/admin/reports/{report}.csv` | `reports:export` | CSV exports (audited) | planned |

### Audit, flags, notifications

| Method | Path | Auth | Purpose | Status |
|---|---|---|---|---|
| GET | `/admin/audit` | `audit:read` | Audit log (filter by actor, resource, date) | planned |
| GET | `/admin/flags` | `flags:manage` | Open / resolved flags | planned |
| POST | `/admin/flags` | `flags:manage` | Raise manual flag | planned |
| POST | `/admin/flags/{id}/resolve` · `/dismiss` | `flags:manage` | With resolution note | planned |
| GET | `/me/notifications` | member | In-app notifications | planned |
| POST | `/me/notifications/{id}/read` · `/me/notifications/read-all` | member | Mark read | planned |

## Adding an endpoint (checklist)

1. Add the Zod request schema and response type to `packages/shared/src/contracts/<module>.ts`.
2. Controller (HTTP only) → service (transaction, audit, outbox) → `domain/` (pure rules).
3. Guards: `@Public()` only if intended; `@RequirePermissions(...)` for admin routes;
   `assertProgramAccess` for program-scoped data; `@CurrentUser()` for the auth context.
4. Map to an explicit DTO, with amounts as strings.
5. Unit tests for domain rules. An integration test for the endpoint, including the forbidden and
   invalid cases.
6. Update the row above (status, final path) and the OpenAPI decorators.
