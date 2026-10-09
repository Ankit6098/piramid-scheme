# CLAUDE.md — Referral & Rewards Platform

Engineering context for this repo. Read this before exploring. Keep it concise and current.

## Purpose

Generic, multi-program referral & rewards platform. Admins configure programs (tied to an approved
product/service), effective-dated reward policies, and approve rewards. Members register (optionally via
a referral link), enroll in programs, see their team tree, sponsor, and rewards/earnings.

**Non-negotiable product rule (agreed with the owner):** rewards are calculated **only** from
qualifying sales of an approved Offering (product/service). Enrollment/joining payments are never a
reward trigger (nor is a member's own plan payment), total rewards per event are capped at ≤ 50% of
the sale amount (enforced in SQL on policies and on every calculation), and real-money payouts are not
implemented (`payouts_enabled` is pinned false by a CHECK). Do not add features that pay ancestors for
recruitment alone.

## Stack

- pnpm 10 workspaces (`corepack pnpm`). Node ≥ 22. TypeScript 5.9 strict.
- `apps/api` — NestJS 11 (Express 5), Prisma 7 (`prisma-client` generator → `src/generated/prisma`,
  `@prisma/adapter-pg`), nestjs-zod, nestjs-pino, BullMQ/Redis, Nodemailer, Vitest (+ unplugin-swc).
- `apps/web` — Next.js 16 App Router (see `apps/web/AGENTS.md`: read `node_modules/next/dist/docs/`
  before using unfamiliar APIs — e.g. `middleware` is now `proxy.ts`), React 19, Tailwind 4, shadcn/ui
  (radix-nova; components in `src/components/ui`), TanStack Query/Table, RHF + Zod, D3, sonner.
- `packages/shared` (`@app/shared`) — Zod request/response contracts, enums, permission keys,
  error codes, amount formatting. Built to CJS `dist/` (`pnpm --filter @app/shared build`).
- Infra: PostgreSQL 17, Redis 7, Mailpit (dev SMTP, UI :8025), nginx reverse proxy, Docker.

## Layout

```
apps/api/prisma/            schema.prisma, migrations/ (Prisma + hand-written invariant SQL), seed.ts
apps/api/src/common/        cross-cutting: auth guards/decorators, errors, filters, pagination, money, audit, outbox, prisma
apps/api/src/config/        zod-validated env config
apps/api/src/modules/<m>/   <m>.module.ts, <m>.controller.ts (HTTP only), <m>.service.ts (use cases),
                            domain/*.ts (pure rules, unit-tested), <m>.repository.ts (optional)
apps/api/src/jobs/          BullMQ queues/processors, outbox relay, schedulers
apps/api/src/main.ts        HTTP entry;  src/worker.ts  background worker entry
apps/api/test/              integration tests (real Postgres `referral_test`)
apps/web/src/app/           (auth)/…, (member)/…, admin/… route groups
apps/web/src/features/<f>/  feature components, hooks (TanStack Query), api calls
apps/web/src/components/    ui/ (shadcn, generated — edit sparingly), app/ (shell, data-table, states)
apps/web/src/lib/           api-client.ts, query keys, format helpers
docs/                       architecture, database, api, security, business-rules, deployment, decisions/
infra/                      nginx/, docker/ (Dockerfiles), postgres/init/
tests/e2e/                  Playwright
```

## Commands

```
docker compose up -d                       # postgres, redis, mailpit (dev)
corepack pnpm install
corepack pnpm --filter @app/shared build   # required before api/web typecheck
corepack pnpm --filter @app/api db:deploy  # apply migrations;  db:seed to seed
corepack pnpm --filter @app/api exec prisma generate
corepack pnpm dev                          # api :4000, web :3000 (web proxies /api → api)
corepack pnpm --filter @app/api test       # unit;  test:integration → needs TEST_DATABASE_URL
corepack pnpm typecheck
docker compose -f docker-compose.prod.yml up --build   # full stack behind nginx on :8080
```
Never run `prisma migrate dev` non-interactively (it hangs); create migrations with
`prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` into a new
`prisma/migrations/<timestamp>_<name>/migration.sql`, then `db:deploy`.

## API conventions

- Base path `/api/v1`; admin endpoints under `/api/v1/admin/*`. OpenAPI at `/api/docs` (non-prod).
- Success: `{ "data": T }`; lists: `{ "data": T[], "page": { "nextCursor": string|null, "limit": n } }`
  (cursor = opaque base64url of the sort key). Errors: `{ "error": { code, message, details?, requestId } }`
  with codes from `@app/shared` `ErrorCode`.
- **Amounts are `bigint` in the API and DB, serialized as decimal strings** (`"amountMinor": "150000"`).
  Never use `number`/floats for money or points. Rates are integer basis points (100 bps = 1%).
- Validate every input with Zod schemas from `@app/shared` via `createZodDto` (nestjs-zod global pipe).
  Map DB rows to explicit response DTOs — never return Prisma entities directly; never expose
  `passwordHash`, `codeHash`, `tokenHash`, emails/phones of other members.
- Controllers: HTTP only. Services: orchestrate use cases + transactions. `domain/`: pure functions.
- Auth is global: routes are protected unless `@Public()`. Use `@RequirePermissions(...)` for admin
  routes and `@CurrentUser()` for the `AuthContext`. Program-scoped admins: call
  `assertProgramAccess(auth, programId)`. Hiding UI is never authorization.
- Mutations: cookie session + CSRF double-submit (`csrf_token` cookie ↔ `x-csrf-token` header) and
  Origin check. Financial mutations accept an `Idempotency-Key` header where noted.
- Multi-row writes use `prisma.$transaction`. Write `AuditService.record(tx, …)` and
  `OutboxService.enqueue(tx, …)` **inside** the same transaction. Never send email inside a DB tx.
- DB trigger violations surface as SQLSTATE `23001` (restrict_violation) → HTTP 409 `INVARIANT_VIOLATION`.
- Log with the injected pino logger; never log OTPs, passwords, tokens, cookies, full emails.

## Domain glossary & invariants (details: docs/business-rules.md)

The DB enforces most invariants with triggers (see the integrity migration + docs/database.md). When a
use case fails with `INVARIANT_VIOLATION`, fix the use case — never weaken a trigger without updating
business-rules.md and the ADRs.

- **Offering**: product/service; starts INACTIVE, SUPER_ADMIN approves. **Program**: one Offering,
  Options (plans), effective-dated **RewardPolicyVersions** (+ **RewardRules**). Published = immutable.
  Program status changes are logged by trigger in `program_status_changes`.
- **Sponsor/parent** = direct referrer. Tree = `referral_relationships` + `referral_paths` (closure,
  incl. depth-0 self rows). Written only (a) by the transaction that creates the user (email
  verification) holding `pg_advisory_xact_lock_shared(7301,1)`, order: user → self row → relationship →
  ancestor rows, no savepoints; or (b) by a correction holding `pg_advisory_xact_lock(7301,1)` after
  inserting a `referral_corrections` row and `SET LOCAL app.referral_correction_id = '<id>'`.
- **QualifyingEvent**: a sale of the program's Offering to an end customer, credited to a subject
  member; idempotent on `(offeringId, externalId, revision)` + `requestHash`. Plan payments are never
  sales. **RewardCalculation**: one per event, snapshot + trace, ≤ 50% cap enforced in SQL.
  **Reward**: one per (event, level); PENDING_APPROVAL→APPROVED→POSTED→REVERSED (+REJECTED); SoD in SQL.
- **Ledger**: double-entry, append-only. Posting = exactly DEBIT platform expense / CREDIT recipient
  payable, `reward-posting:<rewardId>`; reversal mirrors it, `reward-reversal:<rewardId>`. Header stores
  `entryCount` + `debitTotalMinor`. Create accounts with `INSERT … ON CONFLICT DO NOTHING`.
- **PlatformSettings** (singleton): `rewardUnit` MONEY|POINTS, `currencyCode`(+minor units via
  `currencies`), `pointsLabel`. Programs snapshot unit/currency/minor units; policy versions snapshot the
  points rate. Format amounts only via `formatAmount()` with the record's own unit/currency.
- Roles: SUPER_ADMIN, PROGRAM_ADMIN (scoped via program_admin_assignments), FINANCE_REVIEWER, MEMBER.
  `/admin/*` requires a TOTP-verified session (`session.mfaMethod = 'TOTP'`, `mfaVerifiedAt` < 12 h).
- **Secrets**: OTPs only as HMAC; outbox OTP emails carry AES-GCM ciphertext scrubbed after send;
  TOTP secrets encrypted (`MFA_ENCRYPTION_KEY`); audit `before/after` = allow-listed fields, masked PII.

## Testing

- Unit: `*.spec.ts` next to code (domain logic, guards). Integration: `apps/api/test/**/*.int-spec.ts`
  against `TEST_DATABASE_URL` (truncate between tests via `test/utils/db.ts`). E2E: Playwright in
  `tests/e2e`, email OTPs read from the Mailpit API.
- Don't claim a feature works without running its tests.

## Decisions

See `docs/decisions/` (ADRs). Key: modular monolith; Prisma + raw SQL invariants; closure table for
the referral tree; integer minor units; cookie sessions (no JWT in localStorage); outbox for email.
