# syntax=docker/dockerfile:1
#
# API + background worker image (NestJS 11, Prisma 7, argon2). Build context = repository root.
#
#   docker build -f infra/docker/api.Dockerfile -t referral-platform/api .
#
# One image, three roles (always non-root):
#   HTTP API (default CMD)   node dist/main.js
#   Worker                   node dist/worker.js
#   Migrations               prisma migrate deploy      (`prisma` wrapper on PATH, see runtime stage)
# The optional `tools` target (dev dependencies + tsx) runs `db:seed` and other one-off tasks:
#   docker build -f infra/docker/api.Dockerfile --target tools -t referral-platform/api-tools .
#
# Base image: Debian bookworm-slim (glibc). argon2 ships glibc prebuilds and Prisma publishes its
# schema engine for debian-openssl-3.0.x, so nothing is compiled from source and no build toolchain
# is needed. (Alpine works too, but adds musl-specific prebuild/engine variants to keep in step.)

ARG NODE_VERSION=22

# ─── base: Node + pnpm (exact version from package.json "packageManager") ─────
FROM node:${NODE_VERSION}-bookworm-slim AS base
# Fail RUN steps on errors anywhere in a pipeline (inherited by fetch/build/tools).
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
# openssl: required by Prisma's schema engine (prisma generate / migrate).
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY package.json ./
RUN corepack enable && corepack install

# ─── fetch: download every package in the lockfile into the pnpm store ───────
# Inputs are only the lockfile + workspace config, so this layer survives source changes.
FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --frozen-lockfile --store-dir /pnpm/store

# ─── build: install (api + its workspace deps), generate, compile, deploy ─────
FROM fetch AS build
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
COPY . .

# --prefer-offline (not --offline): if the BuildKit cache mount was pruned while the fetch layer
# stayed cached, missing tarballs are downloaded instead of failing the build.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline --store-dir /pnpm/store --filter "@app/api..."

# prisma.config.ts resolves env('DATABASE_URL') eagerly; `prisma generate` never connects, so a
# placeholder is enough here. The real URL is injected at runtime.
RUN pnpm --filter @app/shared build \
 && DATABASE_URL="postgresql://build:build@localhost:5432/build" pnpm --filter @app/api exec prisma generate \
 && pnpm --filter @app/api build \
 && test -f apps/api/dist/main.js \
 && test -f apps/api/dist/worker.js

# Self-contained production tree: prod dependencies only, @app/shared injected (copied) instead of
# symlinked. pnpm 10's default `deploy` requires `inject-workspace-packages=true`, which would change
# the dev workflow and the lockfile settings, so the legacy implementation is used.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @app/api deploy --legacy --prod --store-dir /pnpm/store /out/api

# Build output and Prisma assets are re-copied explicitly so the image never depends on deploy's
# file selection (.gitignore / "files" rules). Sources, tests and build configs are not shipped.
#
# The Prisma CLI is present in the --prod tree as @prisma/client's resolved (optional) peer, but only
# inside the virtual store. Link it at the top level so `prisma migrate deploy` and prisma.config.ts
# (`import 'prisma/config'`) resolve exactly the lockfile-pinned version.
WORKDIR /out/api
RUN rm -rf dist src test prisma prisma.config.ts nest-cli.json tsconfig*.json vitest*.config.ts \
 && cp -R /repo/apps/api/dist ./dist \
 && cp -R /repo/apps/api/prisma ./prisma \
 && cp /repo/apps/api/prisma.config.ts ./prisma.config.ts \
 && if [ ! -e node_modules/prisma ]; then \
      cli="$(find node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d -name 'prisma@*' | head -n 1)"; \
      if [ -z "$cli" ]; then echo 'Prisma CLI missing from the production deploy' >&2; exit 1; fi; \
      ln -s "${cli#node_modules/}/node_modules/prisma" node_modules/prisma; \
    fi \
 && test -f node_modules/prisma/build/index.js \
 && node -e "require('argon2'); require('@app/shared'); require.resolve('@prisma/adapter-pg')"

# Schema engine for `prisma migrate deploy`. The runtime user cannot write to node_modules, so the
# binary for the runtime platform (bookworm-slim + openssl 3 = debian-openssl-3.0.x) must already be
# in the image. `pnpm deploy` may restore @prisma/engines from the store's side-effects cache with
# an engine fetched for another platform (seen: debian-openssl-1.1.x, which made migrate try to
# download at run time and fail with "Can't write to …/@prisma/engines"). Re-run the engines
# postinstall here (openssl 3 is installed, so detection is correct), drop other platforms' engines
# and verify the expected one exists.
RUN engines_dir="$(node -p "require('path').dirname(require.resolve('@prisma/engines/package.json',{paths:[require('fs').realpathSync('node_modules/prisma')]}))")" \
 && (cd "$engines_dir" && node scripts/postinstall.js) \
 && find "$engines_dir" -maxdepth 1 -type f -name 'schema-engine-*' ! -name 'schema-engine-debian-openssl-3.0.x' -delete \
 && test -x "$engines_dir/schema-engine-debian-openssl-3.0.x"
WORKDIR /repo

# ─── tools: full workspace incl. dev dependencies (seed, prisma status, scripts) ─
# Not built by default. Usage: docker compose -f docker-compose.prod.yml run --rm seed
FROM build AS tools
ENV NODE_ENV=production
WORKDIR /repo/apps/api
# Numeric uid of the image's `node` user, so runtimes can verify non-root (e.g. runAsNonRoot).
USER 1000:1000
CMD ["node_modules/.bin/tsx", "prisma/seed.ts"]

# ─── runtime: slim, non-root (default target) ─────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    API_PORT=4000 \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1 \
    NODE_OPTIONS=--enable-source-maps
# tini: PID 1 that forwards SIGTERM (graceful shutdown) and reaps zombies.
# /usr/local/bin/prisma: wrapper so `prisma migrate deploy|status` works in a one-shot container.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && printf '#!/bin/sh\ncd /app && exec node /app/node_modules/prisma/build/index.js "$@"\n' > /usr/local/bin/prisma \
 && chmod 0755 /usr/local/bin/prisma
WORKDIR /app
# Application files stay root-owned, i.e. read-only for the runtime user.
COPY --from=build /out/api ./
# Numeric uid of the image's `node` user, so runtimes can verify non-root (e.g. runAsNonRoot).
USER 1000:1000
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
