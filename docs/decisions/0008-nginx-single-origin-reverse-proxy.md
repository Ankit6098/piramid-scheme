# ADR-0008: nginx single-origin reverse proxy

- **Status:** Accepted
- **Date:** 2026-10-09

## Context

The web app (Next.js) and the API (NestJS) are separate servers. Serving them from different
origins would cause several problems:

- CORS preflights on every mutation;
- `SameSite=None` cookies, which are third-party in some browsers;
- duplicated CSRF origin configuration;
- two public endpoints to secure.

We also want flood protection, uniform security headers and access logs at the edge, and a place
to terminate TLS.

## Decision

- **One public origin** served by nginx (`infra/nginx`, host port 8080 → container 80 in
  `docker-compose.prod.yml`):
  - `/api/*` → `api:4000`, with JSON error bodies from nginx for 429 and 502/503/504 in the API
    envelope `{ "error": { code, message, requestId } }`;
  - `/_next/static/*` → `web:3000`, cached in nginx and served with
    `Cache-Control: public, max-age=31536000, immutable`;
  - everything else → `web:3000`, with response buffering off for App Router streaming and
    WebSocket upgrade headers.
- **Forwarding:** nginx is the edge, so it **overwrites** `X-Forwarded-For` with `$remote_addr`
  and sets `X-Forwarded-Proto` and `X-Forwarded-Host` (port preserved). The API runs with
  `TRUST_PROXY=true` (one hop). `X-Request-Id` is passed through when well-formed, otherwise
  generated (`$request_id`), echoed in responses and logged.
- **Rate limits** (per IP, `limit_req`):
  - state-changing `/api/v1/auth/*` requests: 10 r/min, burst 20;
  - all `/api/*`: 20 r/s, burst 40.

  The API keeps its own finer-grained per-IP and per-account limits.
- **Headers:** `server_tokens off`, `X-Content-Type-Options`, `Referrer-Policy`,
  `X-Frame-Options`, `Permissions-Policy`, COOP and a baseline CSP. Each is added **only if the
  upstream did not set it** (helmet in the API, `headers()` in Next), so nothing is duplicated.
  HSTS is sent only from the TLS server block.
- **Upstreams** use `server … resolve` with Docker's DNS (nginx ≥ 1.27.3). Recreated or scaled
  containers are picked up without reloading nginx, and nginx starts before the apps exist.
- Only nginx publishes a port. PostgreSQL, Redis, the API and the web server stay on an internal
  network.

## Consequences

- Cookies are first-party and same-site. There is no CORS in production (CORS_ORIGINS matters
  only for local dev on :3000).
- One place to add TLS (template in `conf.d/default.conf`), a CDN or a WAF, and one log stream
  with request ids that match API logs.
- If another load balancer is added in front, `set_real_ip_from` (trusted ranges only) and the
  forwarded proto must be configured. Otherwise rate limits and logs see the LB's IP.
- The CSP must allow `'unsafe-inline'` for scripts, because Next.js emits inline bootstrap
  scripts. A strict nonce-based CSP would have to come from Next.js itself (see
  docs/security.md).
- During local development (`pnpm dev`) there is no nginx. Next.js rewrites `/api/*` to the API
  (`API_INTERNAL_URL`), which keeps the same-origin model.

## Alternatives considered

- **Separate origins (`api.example.com`) with CORS:** rejected because of the cookie, CSRF and
  CORS complexity listed above.
- **Next.js rewrites only (no nginx):** works for dev, but leaves rate limiting, buffering
  control, static caching and TLS to Node, and every API request takes an extra hop through Next.
- **Traefik/Caddy:** both viable. nginx was chosen for its explicit limit_req, map-based header
  logic and team familiarity.
