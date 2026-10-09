# Deployment and operations

The platform covers local development, the production-style Docker Compose stack, configuration,
TLS, scaling, backups and the database migration procedure.

```
                    ┌──────────────────────────── backend (internal network) ────────────────────────────┐
 browser ──:8080──▶ │ nginx :80 ──/api/*──▶ api :4000 ──┬──▶ postgres :5432 (pgdata)                    │
 (single origin)    │      │                            └──▶ redis :6379 (redisdata, AOF, password)      │
                    │      └──/*───────▶ web :3000 ──(server-side, API_INTERNAL_URL)──▶ api :4000      │
                    │                    migrate (one-shot: prisma migrate deploy)                        │
                    │                    worker (outbox relay, BullMQ, schedulers) ──▶ postgres, redis    │
                    └────────────────────────────────────────────────────────┬──────────────────────────┘
                                                                     egress │ (worker only)
                                                                            ▼
                                                                     SMTP provider / mailpit (dev-mail)
```

## 1. Local development

Prerequisites: Node ≥ 22 (with corepack), Docker. pnpm comes from corepack
(`packageManager: pnpm@10.x`). Run it as `corepack pnpm …` if `pnpm` is not on your PATH.

```bash
cp .env.example .env                          # root .env (also read by apps/api)
docker compose up -d                          # postgres :5432, redis :6379, mailpit :1025/:8025
corepack pnpm install
corepack pnpm --filter @app/shared build      # required before api/web typecheck
corepack pnpm --filter @app/api exec prisma generate
corepack pnpm db:deploy                       # apply migrations (prisma migrate deploy)
corepack pnpm db:seed                         # roles/permissions, settings, super admin (+ demo data)
corepack pnpm dev                             # api :4000 (watch) + web :3000; web rewrites /api → api
```

| URL | What |
|---|---|
| http://localhost:3000 | Web app (dev). `/api/*` is rewritten to the API. |
| http://localhost:4000/api/v1 | API |
| http://localhost:4000/api/docs | OpenAPI / Swagger UI (non-production only) |
| http://localhost:8025 | Mailpit: all outgoing email, including OTP codes |
| http://localhost:8080 | Production-style stack behind nginx (section 2) |

- The development compose (`docker-compose.yml`) creates the `referral_test` database for
  integration tests (`infra/postgres/init/01-test-db.sql`). Run them with
  `corepack pnpm --filter @app/api test:integration` (needs `TEST_DATABASE_URL`).
- With `RUN_WORKER_IN_API=true`, the API also runs the outbox relay and schedulers, so you don't
  need a separate worker during development.

## 2. Production stack (`docker-compose.prod.yml`)

### Services

| Service | Image | Role | Network | Health |
|---|---|---|---|---|
| `postgres` | `postgres:17-alpine` | Database (`pgdata` volume, data checksums) | backend | `pg_isready` |
| `redis` | `redis:7-alpine` | BullMQ + shared rate-limit counters (`redisdata`, AOF, `requirepass`, `noeviction`) | backend | `redis-cli ping` |
| `migrate` | `…/api` | One-shot `prisma migrate deploy`, then exit 0 | backend | n/a |
| `api` | `…/api` | `node dist/main.js` | backend | `GET /api/v1/health/ready` (DB + Redis) |
| `worker` | `…/api` | `node dist/worker.js` (outbox relay, BullMQ processors, schedulers) | backend + egress | disabled (no HTTP) |
| `web` | `…/web` | Next.js standalone `node apps/web/server.js` | backend | `GET /` → non-5xx |
| `nginx` | `nginx:1.30-alpine` | Single origin on `:80` → host `${NGINX_HTTP_PORT:-8080}` | backend + edge | `GET /nginx-health` |
| `mailpit` | `axllent/mailpit` | **profile `dev-mail`**: catches mail; UI/API on `127.0.0.1:8025` | backend + edge | n/a |
| `seed` | `…/api-tools` (`tools` target) | **profile `ops`**: `tsx prisma/seed.ts` on demand | backend | n/a |

Start order is enforced by `depends_on`:

1. postgres and redis become healthy;
2. `migrate` completes successfully;
3. api and worker start;
4. web starts;
5. nginx starts once api and web are healthy.

### First deployment

```bash
cp .env.example .env && chmod 600 .env
# Fill in at least the required variables (section 3), e.g.:
#   APP_PUBLIC_URL=https://rewards.example.com   POSTGRES_PASSWORD=$(openssl rand -hex 24)
#   REDIS_PASSWORD=$(openssl rand -hex 24)       OTP_PEPPER=$(openssl rand -hex 32)
#   SMTP_HOST=smtp.provider.com SMTP_PORT=587 SMTP_USER=… SMTP_PASSWORD=… MAIL_FROM="Rewards <no-reply@example.com>"
#   SEED_SUPER_ADMIN_EMAIL=… SEED_SUPER_ADMIN_PASSWORD=… SEED_DEMO_DATA=false
docker compose -f docker-compose.prod.yml config -q         # validates interpolation / required vars
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml run --rm seed     # once: roles, settings, first SUPER_ADMIN
curl -fsS http://localhost:8080/api/v1/health/ready
```

After the first login as the seeded super admin, change the password and remove
`SEED_SUPER_ADMIN_PASSWORD` from `.env`.

**Local prod-like run with Mailpit:** set `SMTP_HOST=mailpit SMTP_PORT=1025 SMTP_SECURE=false`
and `APP_PUBLIC_URL=http://localhost:8080`, then run
`docker compose -f docker-compose.prod.yml --profile dev-mail up -d --build`. Secure cookies
work on `http://localhost`. Stop the development Mailpit first, or set `MAILPIT_UI_PORT`,
because both use port 8025.

### Images

- `infra/docker/api.Dockerfile` (default target `runtime`):
  - Debian bookworm-slim (glibc prebuilds for argon2 and Prisma engines, nothing compiled);
  - `pnpm fetch` with a BuildKit cache, then a filtered `pnpm install --frozen-lockfile`;
  - builds `@app/shared`, runs `prisma generate` and `nest build`;
  - `pnpm deploy --legacy --prod` produces a self-contained production tree (pnpm 10's default
    deploy would require `inject-workspace-packages=true`);
  - the runtime image is non-root, uses `tini` as PID 1, and carries a `prisma` wrapper on PATH
    with migrations and `prisma.config.ts`. The same image runs api, worker and migrate.
  - The `tools` target keeps dev dependencies (tsx) for `seed` and one-off maintenance.
- `infra/docker/web.Dockerfile`: Next.js `output: 'standalone'`. In this workspace the server is
  at `.next/standalone/apps/web/server.js`. `.next/static` and `public/` are copied next to it.
  The image is non-root, uses `PORT=3000` and `NEXT_TELEMETRY_DISABLED=1`.
  `API_INTERNAL_URL` (build arg and env, default `http://api:4000`) is used by server-side code
  and by the `/api` rewrite fallback.
- Tag images per release (`IMAGE_REGISTRY`, `IMAGE_TAG`) so a deploy is reproducible and can roll
  back to a previous tag (section 7).

### Day-2 commands

```bash
C="docker compose -f docker-compose.prod.yml"
$C ps                                   # status + health
$C logs -f api worker nginx             # JSON logs (requestId correlates nginx ↔ api)
$C run --rm migrate prisma migrate status
$C exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
$C up -d --scale api=3                  # more API replicas (see section 5)
$C restart worker
```

## 3. Environment variables

The API validates its environment at boot (`apps/api/src/config/env.schema.ts`) and refuses to
start with a readable list of problems. In the production compose, the variables marked
**compose** are set or overridden by `docker-compose.prod.yml` itself, and the ones marked
**required** must be present in `.env`.

| Variable | Required | Default | Used by | Description |
|---|---|---|---|---|
| `NODE_ENV` | | `development` (compose: `production`) | api, worker | `production` enables strict checks (e.g. `OTP_PEPPER` format) and disables OpenAPI. |
| `APP_PUBLIC_URL` | **required** | `http://localhost:8080` | api, worker, web | Public origin. Used for links in emails (`/register?ref=…`) and as an allowed CSRF/CORS origin. Never derive links from the Host header. |
| `CORS_ORIGINS` | | compose: `APP_PUBLIC_URL` | api | Comma-separated extra allowed origins (dev: `http://localhost:3000`). |
| `API_PORT` | | `4000` (compose) | api | HTTP port. |
| `TRUST_PROXY` | | `false` (compose: pinned `true`) | api | Express `trust proxy`: `true` = 1 hop (bundled nginx), a hop count, or a subnet string. The prod compose pins it, because nginx is always the one hop (an LB in front is handled with nginx `set_real_ip_from`). |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | **required** | | postgres, compose | Database credentials. Use URL-safe passwords (hex), because compose embeds them in `DATABASE_URL`. |
| `DATABASE_URL` | dev only | compose builds it | api, worker, migrate | `postgresql://user:pass@host:5432/db?schema=public`. |
| `DATABASE_POOL_MAX` | | `10` | api, worker | pg pool size per process (see section 5). |
| `TEST_DATABASE_URL` | tests | | integration tests | Separate database (`referral_test`). Tests truncate it. |
| `REDIS_PASSWORD` | **required** (prod) | | redis, compose | `requirepass`, embedded into `REDIS_URL`. |
| `REDIS_URL` | dev only | `redis://localhost:6379` (compose builds it) | api, worker | BullMQ and throttler storage. |
| `OTP_PEPPER` | **required** | | api, worker | HMAC key for OTP hashes. 64 hex chars in production (`openssl rand -hex 32`). |
| `SESSION_TTL_HOURS` | | `168` | api | Absolute member session lifetime. |
| `ADMIN_SESSION_TTL_HOURS` | | `12` | api | Absolute session lifetime for users with admin roles. |
| `SESSION_IDLE_TIMEOUT_MINUTES` | | `720` | api | Idle timeout. |
| `COOKIE_SECURE` | | `false` (compose: `true`) | api | `Secure` flag on `sid` / `csrf_token`. Must be `true` behind HTTPS. |
| `SMTP_HOST` | **required** (compose) | `localhost` | worker | SMTP server (`mailpit` with the dev-mail profile). |
| `SMTP_PORT` | | `1025` (compose: `587`) | worker | |
| `SMTP_SECURE` | | `false` | worker | `true` for implicit TLS (port 465). STARTTLS on 587 is negotiated automatically. |
| `SMTP_USER` / `SMTP_PASSWORD` | | | worker | Provider credentials (optional for Mailpit). |
| `MAIL_FROM` | **required** (compose) | `Referral Platform <no-reply@example.com>` | worker | Sender. Must be a domain with SPF/DKIM set up at the provider. |
| `SEED_SUPER_ADMIN_EMAIL` / `SEED_SUPER_ADMIN_PASSWORD` | seed | | seed | First SUPER_ADMIN, created only by `db:seed`. Remove the password afterwards. |
| `SEED_DEMO_DATA` | | `false` | seed | Demo offerings, programs and members. **Keep `false` in production.** |
| `LOG_LEVEL` | | `info` | api, worker | `fatal`…`trace`, `silent`. |
| `RUN_WORKER_IN_API` | | `false` (compose: `false`) | api | Run relay and schedulers inside the API (dev only). |
| `THROTTLE_STORAGE` | | `memory` (compose: `redis`) | api | `redis` makes limits hold across replicas. |
| `THROTTLE_DEFAULT_LIMIT` / `THROTTLE_DEFAULT_TTL_SECONDS` | | `300` / `60` | api | Default per-IP limit. |
| `THROTTLE_AUTH_LIMIT` / `THROTTLE_AUTH_TTL_SECONDS` | | `10` / `60` | api | Login, registration and password-reset routes. |
| `THROTTLE_OTP_LIMIT` / `THROTTLE_OTP_TTL_SECONDS` | | `5` / `60` | api | OTP send and verify routes. |
| `API_INTERNAL_URL` | | `http://localhost:4000` (images: `http://api:4000`) | web | Server-side API base URL and `/api` rewrite target. |
| `NGINX_HTTP_PORT` | | `8080` | compose | Host port for nginx. |
| `MAILPIT_UI_PORT` | | `8025` | compose | Host port (bound to 127.0.0.1) for Mailpit with `dev-mail`. |
| `IMAGE_REGISTRY` / `IMAGE_TAG` | | `referral-platform` / `latest` | compose | Image names: `${IMAGE_REGISTRY}/api:${IMAGE_TAG}`, `…/web`, `…/api-tools`. |
| `E2E_BASE_URL` / `MAILPIT_URL` | | `http://localhost:8080` / `http://localhost:8025` | Playwright | Target stack and Mailpit API for e2e tests. |

## 4. TLS

Pick one of two options.

1. **TLS at a load balancer or CDN** in front of nginx (recommended on cloud platforms):
   - Keep the HTTP server block.
   - In `infra/nginx/nginx.conf`, enable `set_real_ip_from <LB CIDR>` + `real_ip_header X-Forwarded-For`.
     Only trusted ranges, never `0.0.0.0/0`.
   - Forward the LB's `X-Forwarded-Proto` instead of `$scheme` (`snippets/proxy-common.conf`).
   - `TRUST_PROXY` stays 1 hop: nginx resolves the real client IP and overwrites
     `X-Forwarded-For` with it.
2. **TLS in this nginx:** use the commented template at the end of
   `infra/nginx/conf.d/default.conf`:
   - a port-80 server for ACME HTTP-01 challenges plus a 301 to HTTPS;
   - a `listen 443 ssl` + `http2 on` server with TLS 1.2/1.3, session cache and OCSP stapling.

   Mount certificates read-only (`./infra/nginx/certs:/etc/nginx/certs:ro`) and publish
   `443:443` (and `443:443/udp` for HTTP/3). Renew with certbot or lego in webroot mode, then run
   `nginx -s reload`.

In both cases:

- set `APP_PUBLIC_URL=https://…` and `COOKIE_SECURE=true`;
- add `upgrade-insecure-requests` to the CSP default;
- enable **HSTS** only once HTTPS works for every subdomain you include. Start with a short
  `max-age`, raise it to 2 years, and add `preload` only deliberately.

## 5. Scaling notes

- **API:** stateless (sessions live in PostgreSQL, rate-limit counters in Redis with
  `THROTTLE_STORAGE=redis`). Scale horizontally with `--scale api=N` or an orchestrator. nginx
  upstreams use `resolve`, so new replicas are discovered through Docker DNS without a reload.
- **Worker:** safe to run several replicas. The outbox relay claims rows with
  `FOR UPDATE SKIP LOCKED`, and BullMQ job schedulers are keyed by name, so each recurring job
  fires once. Scale it for email throughput, not for availability alone.
- **Web:** Next.js instances are stateless for user data (all user data comes from the API).
  When running several instances, deploy the same build everywhere. If cached or ISR content
  must be shared, configure a shared cache handler, because `.next` is per container.
- **Connection budget:** `(api replicas + worker replicas) × DATABASE_POOL_MAX` plus migrations
  and admin sessions must stay below PostgreSQL `max_connections` (default 100), with headroom.
  Beyond that, add PgBouncer in **transaction** pooling mode. The application relies only on
  transaction-scoped state (`SET LOCAL`, `pg_advisory_xact_lock`), which is compatible with
  transaction pooling.
- **PostgreSQL:** scale vertically first (memory for the closure and ledger indexes). Tune
  `shared_buffers` (~25 % RAM), `effective_cache_size`, `work_mem` and autovacuum for the
  append-heavy tables. Read replicas can serve reports and exports later. Writes and the reward
  engine stay on the primary.
- **Redis:** a single instance with AOF is enough. Use `noeviction` (BullMQ requirement) and size
  memory for queue depth. PostgreSQL remains the source of truth (outbox).
- **nginx:** one instance handles thousands of requests per second. Raise
  `limit_req_zone … 10m` sizes only if many distinct client IPs (millions) are expected.
- **Resource limits:** add `deploy.resources.limits` (memory/cpus) per service once real usage is
  measured. Node defaults to a heap of about half the container memory. Set
  `NODE_OPTIONS=--max-old-space-size=…` explicitly in small containers.

## 6. Backup and restore

### Logical backups (pg_dump)

Use these for daily snapshots, migrations between hosts, and point-in-time copies for analysis.

```bash
C="docker compose -f docker-compose.prod.yml"
mkdir -p backups && chmod 700 backups          # git-ignored; move dumps off-host afterwards
# Custom-format, compressed, consistent snapshot (does not block writers).
$C exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -Z 6 --no-owner' \
  > "backups/referral-$(date -u +%Y%m%dT%H%M%SZ).dump"

# Verify the archive is readable (lists contents without restoring).
pg_restore --list backups/referral-*.dump | head
```

- Schedule the dump, for example daily via cron or a systemd timer on the host. Encrypt it (age,
  gpg or the storage provider's KMS), copy it **off-host**, and keep a retention ladder such as
  7 daily, 4 weekly and 12 monthly.
- `pg_dump` output contains personal data and the full financial history. Treat backups as
  production data (access control, encryption, audit).

**Restore** (into an **empty** database, never on top of live data):

```bash
C="docker compose -f docker-compose.prod.yml"
$C stop api worker web                      # stop writers
$C exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" --if-exists referral_restore && createdb -U "$POSTGRES_USER" referral_restore'
$C exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d referral_restore --no-owner --exit-on-error' \
  < backups/referral-YYYYMMDDTHHMMSSZ.dump
# Validate: migration history, row counts, reconciliation (ledger balances, closure consistency
# query from docs/database.md). Then switch: rename databases (or point POSTGRES_DB at it).
$C exec postgres psql -U "$POSTGRES_USER" -d postgres \
  -c 'ALTER DATABASE referral RENAME TO referral_old' -c 'ALTER DATABASE referral_restore RENAME TO referral'
$C up -d
```

- Restore schema and data together (a full archive). `pg_restore` loads table data before it
  creates triggers and foreign keys (post-data section), so append-only and balance triggers do
  not interfere.
- **Do not** use `--data-only` into an existing schema: the deferred ledger-balance and guard
  triggers would fire on partial data.
- Test a restore at least quarterly, and after every major migration. A backup that was never
  restored is not a backup.

### Point-in-time recovery (PITR)

`pg_dump` only restores to the moment of the dump. To recover to an arbitrary point (for example
just before an accidental bulk change), use continuous WAL archiving plus base backups:

- **Managed PostgreSQL** (RDS, Cloud SQL, Azure, Crunchy, Neon …): enable automated backups with
  PITR and choose the retention window (7–35 days). Restore creates a new instance at a timestamp.
- **Self-hosted:** use **pgBackRest** or **WAL-G** (or Barman):
  - set `wal_level=replica`, `archive_mode=on` and an `archive_command` that pushes WAL segments
    to object storage, plus a weekly full and daily differential or incremental base backup;
  - to recover, restore the base backup and set `restore_command` and
    `recovery_target_time = '2026-10-09 14:03:00+00'` (and `recovery_target_action = 'promote'`)
    for PostgreSQL ≥ 12;
  - start the server, verify, then repoint the app.
  - Run the archiver as a sidecar container sharing the `pgdata` volume, or move PostgreSQL to a
    host or managed service. The bundled single-container compose setup is fine for small
    deployments that accept daily-dump RPO.
- Pick RPO and RTO explicitly. Daily `pg_dump` gives up to 24 h RPO. WAL archiving gives an RPO of
  seconds to minutes.
- Ledger and audit tables are append-only. After a PITR to before an incident, replay legitimate
  business events that happened after the target time from their sources (the event intake is
  idempotent on `(source, external_id)`).

**Redis** needs no backup for correctness: the outbox in PostgreSQL is the source of truth, and
schedulers are re-installed at worker start. Keep the AOF volume for faster recovery of in-flight
jobs.

## 7. Database migrations

**Rule: production schemas change only through `prisma migrate deploy`.** Never run
`prisma db push`: it bypasses migration history and drops hand-written constraints and triggers.
Never run `prisma migrate dev` or `migrate reset` against shared databases: they are interactive
and can reset data.

Procedure for every release:

1. **Author** the migration in a branch with `prisma migrate diff` (see
   [database.md](database.md#working-with-migrations)). Add invariant SQL by hand and document it
   in `docs/database.md`. CI applies all migrations to a fresh database (`integration` job) and
   runs the integration tests.
2. **Review** for locking and duration:
   - adding a `NOT NULL` column with a volatile default, or rewriting large tables, takes long
     locks;
   - create big indexes `CONCURRENTLY` in their own migration;
   - backfill in batches from a script, not inside the migration.
3. **Back up** before applying (section 6), or confirm the PITR window.
4. **Apply:** `docker compose -f docker-compose.prod.yml up -d` runs the `migrate` service first.
   api and worker start only after it exits 0. To apply explicitly:
   `docker compose -f docker-compose.prod.yml run --rm migrate`. Check status with
   `… run --rm migrate prisma migrate status`.
5. **Verify:** health checks, logs, reconciliation page.

**Zero-downtime changes (expand → migrate → contract).** Make every migration backward compatible
with the previous release, so old and new API containers can run side by side during a rolling
restart:

- add columns as nullable or with a default, and write to both old and new during the transition;
- stop reading the old column in release N+1 and drop it in N+2;
- never rename in place: add the new name, backfill, then drop.

**Rollback strategy = forward fix.**

- Down migrations are not used. A problem is fixed by a **new** migration (for example
  re-creating a dropped index or relaxing a constraint) and a new release.
- An application rollback (previous `IMAGE_TAG`) is safe only because migrations are expand-only
  within a release.
- If `migrate deploy` fails halfway, `migrate` exits non-zero and the app does not start.
  Inspect `_prisma_migrations`, fix the database state manually if needed, then mark the
  migration with `prisma migrate resolve --rolled-back <name>` (after undoing its partial
  effects) or `--applied <name>` (after completing it by hand), and redeploy.
- Restoring a backup is a last resort for destructive mistakes (data loss). It also discards
  every write since the backup, so prefer PITR to just before the incident.
- Never edit or delete an applied migration file: Prisma verifies checksums.

## 8. Upgrades and releases

```bash
git pull && export IMAGE_TAG=$(git rev-parse --short HEAD)
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d          # migrate → api/worker → web → nginx
docker compose -f docker-compose.prod.yml ps
```

Compose replaces containers one service at a time. For true rolling updates without a blip, run
two API replicas and recreate them one by one, or use an orchestrator. nginx retries an
idempotent request on another upstream when a connection fails.

## 9. CI

`.github/workflows/ci.yml`:

- `quality`: lint, typecheck, unit tests.
- `integration`: PostgreSQL 17 + Redis 7 services; `prisma migrate deploy` + `test:integration`.
- `build`: shared, api, web.
- `docker`: builds the api, api-tools and web images with the GHA layer cache.
- `e2e`: loads the images, starts `docker-compose.prod.yml` with `dev-mail`, seeds, runs
  Playwright (desktop Chromium + Pixel 7), and uploads the report.

Concurrency is grouped per branch or PR, and the token has read-only `contents` permission.
