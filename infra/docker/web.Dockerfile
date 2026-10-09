# syntax=docker/dockerfile:1
#
# Web image (Next.js 16 App Router, `output: 'standalone'`). Build context = repository root.
#
#   docker build -f infra/docker/web.Dockerfile -t referral-platform/web .
#
# Standalone layout in this pnpm workspace: Next infers the tracing root from the root lockfile, so
# the server lands at .next/standalone/apps/web/server.js next to a pruned, symlinked
# .next/standalone/node_modules/.pnpm tree (including @app/shared's dist). `public/` and
# `.next/static` are not part of the trace and are copied in explicitly.
#
# Browsers reach the API through the same origin (nginx routes /api/* to the API), so no API URL is
# baked into client bundles. Server-side code calls the API directly at API_INTERNAL_URL.

ARG NODE_VERSION=22

# ─── base: Node + pnpm (exact version from package.json "packageManager") ─────
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
COPY package.json ./
RUN corepack enable && corepack install

# ─── fetch: download every package in the lockfile into the pnpm store ───────
FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --frozen-lockfile --store-dir /pnpm/store

# ─── build ─────────────────────────────────────────────────────────────────────
FROM fetch AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline --store-dir /pnpm/store --filter "@app/web..."

# Server-side only. Anything that next.config.ts evaluates at build time (e.g. rewrites) sees the
# in-cluster API address; override with --build-arg for other topologies.
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=${API_INTERNAL_URL}

RUN --mount=type=cache,id=next-build-cache,target=/repo/apps/web/.next/cache \
    pnpm --filter @app/shared build \
 && pnpm --filter @app/web build \
 && if [ ! -f apps/web/.next/standalone/apps/web/server.js ]; then \
      echo "Missing .next/standalone/apps/web/server.js: set output: 'standalone' in apps/web/next.config.ts" >&2; \
      exit 1; \
    fi

# ─── runtime: slim, non-root ───────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    API_INTERNAL_URL=http://api:4000
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Server code and node_modules stay root-owned (read-only for the runtime user) ...
COPY --from=build /repo/apps/web/.next/standalone ./
# ... while .next stays writable: the incremental cache (ISR output, image cache) lives there.
COPY --from=build --chown=1000:1000 /repo/apps/web/.next/standalone/apps/web/.next ./apps/web/.next
COPY --from=build --chown=1000:1000 /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
# Numeric uid of the image's `node` user, so runtimes can verify non-root (e.g. runAsNonRoot).
USER 1000:1000
EXPOSE 3000
# Any non-5xx answer counts as healthy (the root page may redirect to /login).
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/web/server.js"]
