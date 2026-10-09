# Referral & Rewards Platform

A multi-program referral and rewards platform. Admins configure **programs** for an approved
product or service (an *Offering*), define effective-dated **reward policies**, record
**qualifying sales** and approve the resulting rewards. Members register (optionally through a
referral link), enroll in programs, see their team, and follow their rewards and earnings. Rewards
are recorded in an append-only, double-entry **ledger**.

> **Compliance by design.** Rewards are funded **only by qualifying sales of an approved
> offering**. Registration, referrals and enrollment payments never trigger rewards. Total rewards
> per sale are capped at **≤ 50 %** of the sale amount by a database constraint. The product makes
> no income promises, and real-money payouts are not implemented (`payouts_enabled` stays false
> until legal, KYC and payment-provider approvals exist). See
> [docs/business-rules.md §0](docs/business-rules.md#0-compliance-guardrails-fixed-not-configurable)
> and [ADR-0007](docs/decisions/0007-sale-funded-rewards-budget-cap.md).

## Stack

| Part | Technology |
|---|---|
| `apps/api` | NestJS 11 (Express 5), Prisma 7 + PostgreSQL 17, BullMQ/Redis, nestjs-zod, pino, Nodemailer, Vitest |
| `apps/web` | Next.js 16 (App Router), React 19, Tailwind 4, shadcn/ui, TanStack Query/Table, React Hook Form + Zod, D3 |
| `packages/shared` | `@app/shared`: Zod contracts, enums, permissions, error codes, amount formatting |
| Infra | Docker, nginx (single origin), Mailpit (dev email), GitHub Actions, Playwright |

## Quick start (development)

Requires Node ≥ 22 (corepack) and Docker. pnpm is provided by corepack. If `pnpm` is not on your
PATH, prefix commands with `corepack`.

```bash
cp .env.example .env                              # local defaults (placeholders only)
docker compose up -d                              # postgres, redis, mailpit
corepack pnpm install
corepack pnpm --filter @app/shared build          # shared package → dist (needed by api and web)
corepack pnpm --filter @app/api exec prisma generate
corepack pnpm db:deploy                           # prisma migrate deploy
corepack pnpm db:seed                             # roles, settings, super admin (+ demo data)
corepack pnpm dev                                 # api :4000 + web :3000
```

Sign in at http://localhost:3000 with `SEED_SUPER_ADMIN_EMAIL` / `SEED_SUPER_ADMIN_PASSWORD`
from `.env`. The admin MFA code arrives in Mailpit (http://localhost:8025).

### Default URLs

| URL | What |
|---|---|
| http://localhost:3000 | Web app (dev server; `/api/*` is rewritten to the API) |
| http://localhost:4000/api/v1 | API (dev) |
| http://localhost:4000/api/docs | OpenAPI / Swagger UI (non-production) |
| http://localhost:8025 | Mailpit: every outgoing email, including OTP codes |
| http://localhost:8080 | Production-style stack behind nginx (`docker-compose.prod.yml`) |

### Production-style stack

```bash
docker compose -f docker-compose.prod.yml up -d --build      # needs a filled-in .env (see docs/deployment.md)
docker compose -f docker-compose.prod.yml run --rm seed      # first run only
```

## Scripts

| Command | What it does |
|---|---|
| `corepack pnpm dev` | Run api (watch) and web (dev) in parallel |
| `corepack pnpm build` | Build shared → api → web |
| `corepack pnpm typecheck` / `lint` | Typecheck / lint every package |
| `corepack pnpm test` | Unit tests (all packages) |
| `corepack pnpm test:integration` | API integration tests against `TEST_DATABASE_URL` (real PostgreSQL) |
| `corepack pnpm test:e2e` | Playwright against `E2E_BASE_URL` (default http://localhost:8080) |
| `corepack pnpm db:deploy` | Apply migrations (`prisma migrate deploy`) |
| `corepack pnpm db:seed` | Seed roles/permissions, settings, super admin, optional demo data |
| `corepack pnpm --filter @app/api exec prisma generate` | Regenerate the Prisma client |
| `corepack pnpm format` | Prettier |

Never run `prisma migrate dev` against shared databases, and never use `prisma db push`. See
[docs/database.md](docs/database.md#working-with-migrations) for creating migrations.

## Project layout

```
apps/
  api/            NestJS API + worker (src/main.ts, src/worker.ts)
    prisma/       schema.prisma, migrations/ (Prisma + hand-written invariant SQL), seed.ts
    src/common/   auth guards, CSRF, errors, audit, outbox, pagination, prisma, redis, throttling
    src/modules/  feature modules (controller → service → domain/)
    src/jobs/     outbox relay, BullMQ processors, schedulers
    test/         integration tests
  web/            Next.js app (src/app route groups, src/features, src/components)
packages/
  shared/         @app/shared — contracts, enums, permissions, error codes, amounts
infra/
  docker/         api.Dockerfile, web.Dockerfile
  nginx/          nginx.conf, conf.d/default.conf, snippets/
  postgres/init/  dev init scripts (creates referral_test)
tests/e2e/        Playwright specs + utils (Mailpit OTP helper)
docs/             business rules, architecture decisions, database, API, security, deployment
docker-compose.yml        dev infrastructure (postgres, redis, mailpit)
docker-compose.prod.yml   full stack behind nginx
```

## Documentation

- [Business rules](docs/business-rules.md): the authoritative domain rules
- [Database](docs/database.md): entities, invariants, closure-table queries, concurrency, deletion policies
- [API](docs/api.md): conventions and endpoint catalogue
- [Security](docs/security.md): threat model, auth, sessions, CSRF, rate limits, RBAC, audit, logging
- [Deployment](docs/deployment.md): local dev, production compose, environment variables, TLS, scaling, backups, migrations
- [Architecture decisions](docs/decisions/README.md): ADR-0001 … ADR-0008
- [CLAUDE.md](CLAUDE.md): engineering conventions for contributors and coding agents
