# Referral & Rewards Platform

A generic, multi-program **referral and rewards platform**. Administrators define programs around
an approved product or service (an *Offering*), publish effective-dated reward policies, record
qualifying sales and approve the resulting rewards. Members register (optionally through a
referral link), enroll in programs, see their team, and follow their rewards and earnings. Every
posted reward is recorded in an append-only, double-entry ledger.

- **Rewards come only from real sales.** A reward is created only when a sale of the program's
  approved offering to an end customer is recorded, and it goes to the selling member's upline.
  Registering, referring someone and paying for a plan never create rewards.
- **Money or points.** A Super Admin chooses the platform's reward unit (`MONEY` or `POINTS`), the
  currency (from a fixed ISO 4217 list, with its minor units) and the points label. Each program
  snapshots the unit and currency at creation, so history never changes when settings do.
- **Built to be audited.** Integer minor units everywhere (never floats), database-enforced
  invariants (the 50 % cap, the referral tree, the ledger shape, segregation of duties), an
  append-only audit log and a continuous reconciliation report.

> **Compliance by design.** Total rewards per sale are capped at **≤ 50 %** of the sale amount by
> database constraints on every policy and every calculation. A member's own plan payment is
> never a sale. Rewards from manually recorded sales always need a second person to approve them.
> The product makes no income promises, and real-money payouts are not implemented
> (`payouts_enabled` is pinned to false by a CHECK constraint). See [Compliance](#compliance).

## Contents

- [Features by role](#features-by-role)
- [Stack](#stack)
- [Quick start (development)](#quick-start-development)
- [Production with Docker and nginx](#production-with-docker-and-nginx)
- [Testing](#testing)
- [Scripts](#scripts)
- [Project layout](#project-layout)
- [Documentation](#documentation)
- [Compliance](#compliance)

## Features by role

**Member**

- Register with email verification (optionally through a referral link `/register?ref=CODE`), sign
  in, reset the password, manage profile, email address, open sessions and activity.
- Dashboard: active enrollments, team size, earned / pending / reversed rewards per unit and
  currency, recent activity, announcements, in-app notifications.
- Browse programs, read the terms and the reward policy in effect, enroll in a plan (free plans
  activate immediately; paid plans after an admin records the offline payment), cancel.
- Share a personal referral code; see the sponsor and upline, and the team tree up to 10 levels
  (display names only: first name + last initial, never contact details or amounts).
- Rewards list with status history and reasons, earnings computed from the ledger, CSV export.

**Program Admin** (scoped to assigned programs)

- Create and edit programs and plans, publish, pause, resume, complete and archive them.
- Draft, validate, dry-run and publish reward policies (approval-requiring policies only).
- Review the enrollment queue: record offline payments, reject or cancel enrollments.
- Record sales for program members (never for themselves or their own downline), view sales,
  calculation traces and rewards, view enrolled members and their teams.

**Finance Reviewer** (platform-wide, read + financial decisions)

- Approve (approve + post), reject or reverse rewards, singly or in bulk, with four-eyes rules
  enforced (never their own reward, never a sale they recorded).
- Reverse sales (refunds, chargebacks): live rewards are rejected, posted ones reversed in the
  ledger.
- Ledger transactions, accounts and balances, the reconciliation report, CSV exports, the audit
  log.

**Super Admin**

- Everything above, plus: platform settings (reward unit, currency, points label, policy
  defaults), offering approval, roles and program-admin assignments, member suspension and
  admin-triggered password resets,
  auto-approving policies, API clients for sales systems, sponsor corrections (audited, with a
  preview), fraud flags.

**Platform**

- Admin area protected by TOTP (authenticator app) with session rotation; cookie sessions with
  CSRF protection; rate limits and login backoff.
- Sale ingestion API for external systems (`POST /api/v1/integrations/events`, per-program API
  keys), idempotent per sale.
- Transactional outbox for email and notifications, background worker, scheduled jobs (program
  start/end, enrollment expiry, stuck-sale sweeper, cleanups).

## Stack

| Part | Technology |
|---|---|
| `apps/api` | NestJS 11 (Express 5), Prisma 7 + PostgreSQL 17, BullMQ/Redis, nestjs-zod, pino, Nodemailer, Vitest |
| `apps/web` | Next.js 16 (App Router, Cache Components), React 19, Tailwind 4, shadcn/ui, TanStack Query/Table, React Hook Form + Zod, D3 |
| `packages/shared` | `@app/shared`: Zod contracts, enums, permissions, error codes, amount formatting |
| Infra | Docker, nginx (single origin), Mailpit (dev email), Playwright |

## Quick start (development)

Requires Node ≥ 22 (with corepack) and Docker. pnpm 10 comes from corepack; if `pnpm` is not on
your PATH, prefix the commands with `corepack` (`corepack pnpm …`).

```bash
cp .env.example .env                              # local defaults (placeholders only)
#   then set RUN_WORKER_IN_API=true in .env       # emails, one-time codes and jobs in dev (see below)
docker compose up -d                              # postgres :5432, redis :6379, mailpit :1025/:8025
pnpm install
pnpm --filter @app/shared build                   # shared package → dist (needed by api and web)
pnpm --filter @app/api exec prisma generate
pnpm db:deploy                                    # prisma migrate deploy
SEED_DEMO_DATA=true pnpm db:seed                  # roles, settings, super admin + demo data
pnpm dev                                          # api :4000 + web :3000
```

`RUN_WORKER_IN_API=true` makes the API process also run the outbox relay (emails, one-time
codes, notifications) and the scheduled jobs. With the default `false`, no email is delivered in
development unless you run the worker separately
(`pnpm --filter @app/api build && pnpm --filter @app/api start:worker`).

### Demo accounts

`SEED_DEMO_DATA=true` builds a compliant demo scenario through the real domain services: the
approved product "Premium Wellness Kit", the live program "Wellness Partners" (`demo-wellness`)
with four plans and a five-level policy (20 % total budget per sale), a referral tree, activated
enrollments and five product sales; three are approved and posted by the finance reviewer, two
wait for approval. Amounts use the platform settings at seed time (default: points, INR).

| Account | Role | Password |
|---|---|---|
| `SEED_SUPER_ADMIN_EMAIL` (`admin@example.com` in `.env.example`) | Super Admin | `SEED_SUPER_ADMIN_PASSWORD` |
| `finance@example.com` | Finance Reviewer | `Demo@12345678` |
| `programs@example.com` | Program Admin (assigned to Wellness Partners) | `Demo@12345678` |
| `anita@example.com` | Member, top of the demo tree | `Demo@12345678` |
| `rahul@`, `amit@`, `priya@`, `kiran@`, `neha@`, `vikram@`, `sunita@example.com` | Members | `Demo@12345678` |

Demo tree: Anita → Rahul (→ Priya (→ Neha, Vikram), Kiran) and Amit (→ Sunita). The demo password
can be changed with `SEED_DEMO_PASSWORD` before seeding. The seed is idempotent (it skips demo data
that already exists).

**Admin sign-in needs an authenticator app.** Admin accounts must enroll TOTP at their first login:
sign in with the password, enter the email code (open Mailpit at http://localhost:8025), then scan
the QR code with an authenticator app (Google Authenticator, 1Password, Authy, …) and confirm a
code. Later logins ask for the authenticator code. The member area works without it; `/admin`
requires it.

### Default URLs

| URL | What |
|---|---|
| http://localhost:3000 | Web app (dev server; `/api/*` is rewritten to the API) |
| http://localhost:4000/api/v1 | API (dev) |
| http://localhost:4000/api/docs | OpenAPI / Swagger UI (non-production) |
| http://localhost:8025 | Mailpit: every outgoing email, including one-time codes |
| http://localhost:8080 | Production-style stack behind nginx (`docker-compose.prod.yml`) |

## Production with Docker and nginx

`docker-compose.prod.yml` runs the full stack behind one origin: nginx (`:8080` by default) routes
`/api/*` to the API and everything else to the Next.js server; a one-shot `migrate` service applies
migrations before the API and the worker start. PostgreSQL and Redis stay on an internal network.

```bash
cp .env.example .env && chmod 600 .env
# Fill in real values: APP_PUBLIC_URL, CORS_ORIGINS, POSTGRES_PASSWORD, REDIS_PASSWORD,
# OTP_PEPPER / OTP_OUTBOX_KEY / MFA_ENCRYPTION_KEY (64 hex each, all different: openssl rand -hex 32),
# SMTP_* and MAIL_FROM, COOKIE_SECURE=true, SEED_SUPER_ADMIN_EMAIL/PASSWORD, SEED_DEMO_DATA=false
docker compose -f docker-compose.prod.yml config -q          # validate the configuration
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml run --rm seed      # first run: roles, settings, first Super Admin
curl -fsS http://localhost:8080/api/v1/health/ready
```

- **TLS:** terminate it in nginx (template in `infra/nginx/conf.d/default.conf`) or at a load
  balancer in front; then set `APP_PUBLIC_URL=https://…` and `COOKIE_SECURE=true`.
- **Validate nginx changes:** `docker run --rm -v "$PWD/infra/nginx:/etc/nginx:ro" nginx:alpine nginx -t`.
- **Local prod-like run with Mailpit:** set `SMTP_HOST=mailpit SMTP_PORT=1025` and add
  `--profile dev-mail` to `up`.
- Scaling, backups, point-in-time recovery, migrations and upgrades:
  [docs/deployment.md](docs/deployment.md). Production checklist:
  [docs/security.md §14](docs/security.md#14-production-checklist).

## Testing

```bash
pnpm --filter @app/shared build                    # once, before typecheck/tests
pnpm test                                          # unit tests of every package (no database)
pnpm --filter @app/api test                        # API unit tests only

# API integration tests against real PostgreSQL + Redis + Mailpit. The database name must contain
# "test"; it is created and migrated automatically and truncated between tests.
TEST_DATABASE_URL=postgresql://referral:<password>@localhost:5432/referral_test?schema=public \
  pnpm test:integration
# one folder/file: pnpm --filter @app/api exec vitest run --config vitest.integration.config.ts test/rewards

pnpm typecheck                                     # every package
pnpm lint
pnpm test:e2e                                      # Playwright against E2E_BASE_URL (default http://localhost:8080)
```

The integration suite includes `test/db-invariants.int-spec.ts`, which attacks every database
guard with raw SQL and checks that it is refused. End-to-end tests read one-time codes from the
Mailpit API (`tests/e2e/utils/mailpit.ts`).

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Run api (watch) and web (dev) in parallel |
| `pnpm build` | Build shared → api → web |
| `pnpm typecheck` / `pnpm lint` | Typecheck / lint every package |
| `pnpm test` | Unit tests (all packages) |
| `pnpm test:integration` | API integration tests against `TEST_DATABASE_URL` |
| `pnpm test:e2e` | Playwright end-to-end tests |
| `pnpm db:deploy` | Apply migrations (`prisma migrate deploy`) |
| `pnpm db:seed` | Seed roles/permissions, settings, the Super Admin, and demo data when `SEED_DEMO_DATA=true` |
| `pnpm --filter @app/api exec prisma generate` | Regenerate the Prisma client |
| `pnpm --filter @app/api openapi` | Export the OpenAPI spec |
| `pnpm format` | Prettier |

Never run `prisma migrate dev` non-interactively or `prisma db push`. Create migrations from the
schema diff as described in [docs/database.md](docs/database.md#working-with-migrations).

## Project layout

```
apps/
  api/                 NestJS API + worker (src/main.ts, src/worker.ts)
    prisma/            schema.prisma, migrations/ (Prisma + hand-written invariant SQL), seed.ts, seed-demo.ts
    src/common/        auth guards, CSRF, errors, audit, outbox, idempotency, pagination, prisma, throttling, crypto
    src/modules/       16 feature modules (controller → service → domain/), see docs/architecture.md
    src/jobs/          outbox relay, email + notification handlers, scheduler, cleanup jobs
    test/              integration tests (+ utils: test app, factories, loginAs)
  web/                 Next.js app: src/app ((auth), (member), admin route groups), src/features, src/components
packages/
  shared/              @app/shared: contracts, enums, permissions, error codes, amounts
infra/
  docker/              api.Dockerfile, web.Dockerfile
  nginx/               nginx.conf, conf.d/default.conf (+ TLS template), snippets/
  postgres/init/       dev init scripts (creates referral_test)
tests/e2e/             Playwright harness and utils (Mailpit OTP helper)
docs/                  business rules, architecture, database, API, security, deployment, frontend, ADRs
docker-compose.yml        dev infrastructure (postgres, redis, mailpit)
docker-compose.prod.yml   full stack behind nginx
```

## Documentation

- [Business rules](docs/business-rules.md): the authoritative domain rules
- [Architecture](docs/architecture.md): system overview, module map, request and processing flows, API core contracts
- [Database](docs/database.md): entities, every invariant with its rationale, state machines, the referral write protocol, ledger shape, indexes, concurrency, retention
- [API](docs/api.md): conventions and the endpoint catalogue, with detailed slice docs in [docs/api/](docs/api/)
- [Security](docs/security.md): threat model, authentication, sessions, CSRF, rate limits, headers, RBAC, audit, secrets
- [Deployment](docs/deployment.md): local development, production compose, environment variables, TLS, scaling, backups, migrations
- [Frontend](docs/frontend.md): rendering model, data fetching, component kit, accessibility
- [Architecture decisions](docs/decisions/README.md): ADR-0001 … ADR-0012
- [CLAUDE.md](CLAUDE.md): engineering conventions for contributors and coding agents

## Compliance

The platform is designed so that non-compliant configurations are **impossible**, not merely
discouraged ([business-rules.md §0](docs/business-rules.md#0-compliance-guardrails-fixed-not-configurable),
[ADR-0007](docs/decisions/0007-sale-funded-rewards-budget-cap.md)):

- **Sale-funded only.** Rewards are triggered only by `PRODUCT_SALE`, `SERVICE_COMPLETED` or
  `SUBSCRIPTION_RENEWAL` events for the program's approved (ACTIVE) offering, each naming an end
  customer. There is no registration, referral or enrollment trigger anywhere in the schema or the
  engine. The database rejects a "sale" whose id is a plan-payment reference or that matches the
  member's own plan payment (same amount within ±2 days), and the reconciliation report flags
  look-alikes for review.
- **Budget cap.** Rewards for one sale never exceed the policy budget, and the budget never exceeds
  50 % of the sale: enforced by CHECK constraints on policies, on settings defaults and on every
  stored calculation (which the database re-derives from the sale).
- **Four eyes on money.** Nobody approves, rejects or reverses their own reward; whoever recorded a
  sale cannot approve its rewards; admins cannot record sales for themselves or their downline;
  rewards from manual sales always need human approval; only a Super Admin can publish an
  auto-approving policy ([ADR-0011](docs/decisions/0011-db-enforced-segregation-of-duties.md)).
- **No payouts, no promises.** The ledger records liabilities only; `payouts_enabled` stays false
  until a reviewed migration after legal, KYC and payment-provider approval. The UI never shows
  projected or guaranteed income, and plan prices are the price of the offering's plan, not an
  investment.
- **Fair attribution.** A member is attached to a sponsor only in the transaction that verifies
  their email ([ADR-0010](docs/decisions/0010-deferred-user-creation-anti-squatting.md)); later
  changes go only through the audited Super Admin correction protocol and never change past
  rewards.
- **Privacy.** Members see other members only as display names with depth, join date and status,
  never contact details, prices, rewards or sale amounts. Audit entries store masked emails and
  phones and never secrets.

Operators remain responsible for the legal review of each program (consumer protection, direct
selling and tax rules in their jurisdictions) before going live.
