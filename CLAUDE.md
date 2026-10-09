# CLAUDE.md — Referral & Rewards Platform

Engineering context for this repo. Read this before exploring. Keep it concise and current.

## Purpose

Generic, multi-program referral & rewards platform. Admins configure programs (tied to an approved
product/service), effective-dated reward policies, and approve rewards. Members register (optionally via
a referral link), enroll in programs, see their team tree, sponsor, and rewards/earnings.

**Non-negotiable product rule (agreed with the owner):** rewards are calculated **only** from
qualifying sales of an approved Offering (product/service). Enrollment/joining payments are never a
reward trigger, total rewards per event are capped at ≤ 50% of the sale amount (DB CHECK), and
real-money payouts are not implemented (`platform_settings.payouts_enabled` stays false). Do not add
features that pay ancestors for recruitment alone.

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

- **Offering**: approved product/service. **Program**: references one Offering, has Options (plans) and
  effective-dated **RewardPolicyVersions** (+ **RewardRules** per level). Published versions are immutable.
- **Sponsor/parent** = direct referrer. Tree = `referral_relationships` (adjacency, one sponsor per
  child, written once at registration) + `referral_paths` (closure table incl. depth-0 self rows).
  Changes only through the audited correction flow (`SET LOCAL app.referral_correction = 'on'`).
- **QualifyingEvent**: a sale of an Offering credited to a subject member; idempotent on
  `(source, externalId)`. **RewardCalculation**: one per event, full trace, immutable.
  **Reward**: one per (event, level); state machine PENDING_APPROVAL→APPROVED→POSTED→REVERSED (+REJECTED).
- **Ledger**: double-entry, append-only. Posting = DEBIT platform expense / CREDIT member payable.
  Reversal = compensating transaction. Idempotency keys `reward-posting:<id>` / `reward-reversal:<id>`.
- **PlatformSettings** (singleton): `rewardUnit` MONEY|POINTS, `currencyCode`, `pointsLabel`. Programs
  snapshot unit+currency at creation (frozen after publish). Format amounts only via
  `formatAmount()` from `@app/shared`.
- Roles: SUPER_ADMIN, PROGRAM_ADMIN (scoped via program_admin_assignments), FINANCE_REVIEWER, MEMBER.
  Admin sessions require email-OTP second factor (`session.mfaVerified`).

## Testing

- Unit: `*.spec.ts` next to code (domain logic, guards). Integration: `apps/api/test/**/*.int-spec.ts`
  against `TEST_DATABASE_URL` (truncate between tests via `test/utils/db.ts`). E2E: Playwright in
  `tests/e2e`, email OTPs read from the Mailpit API.
- Don't claim a feature works without running its tests.

## Decisions

See `docs/decisions/` (ADRs). Key: modular monolith; Prisma + raw SQL invariants; closure table for
the referral tree; integer minor units; cookie sessions (no JWT in localStorage); outbox for email.
