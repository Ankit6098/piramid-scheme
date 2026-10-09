# Security

How the platform protects accounts, money-like data and personal data. The authoritative rules
for authentication and roles are [business-rules.md §2–3](business-rules.md#2-accounts--authentication).
This document explains the controls and where they live. Related decisions:

- [ADR-0005](decisions/0005-cookie-sessions-csrf-email-otp-mfa.md) (sessions, CSRF, MFA);
- [ADR-0007](decisions/0007-sale-funded-rewards-budget-cap.md) (compliance guardrails);
- [ADR-0008](decisions/0008-nginx-single-origin-reverse-proxy.md) (edge).

## 1. Threat model (summary)

**Assets**

- Member accounts and sessions.
- Admin capabilities: approving or reversing rewards, correcting the referral tree, changing
  settings and roles.
- Reward and ledger integrity.
- Personal data (names, emails, phones, IPs).
- Secrets: `OTP_PEPPER`, DB/Redis/SMTP credentials.

**Actors**

- Anonymous internet users and bots.
- Members, including dishonest ones: self-referral, fake downlines, scraping other members' data.
- Compromised member or admin accounts.
- A malicious or mistaken admin acting within their role.
- An attacker with read access to a backup or log.

**Trust boundaries**

- Browser → nginx (public).
- nginx → API / web (internal network).
- API / worker → PostgreSQL / Redis (internal).
- Worker → SMTP provider (egress).
- Admin area (`/api/v1/admin/*`, requires MFA).

| Threat | Main mitigations |
|---|---|
| Credential stuffing / brute force | argon2id hashes; generic login errors; lockout after 5 consecutive failures (15 min); per-IP + per-account rate limits in the API; nginx limit on auth mutations (10 r/min/IP, burst 20). |
| Account enumeration | Registration and password reset return the same response for known and unknown emails (an existing address gets a "someone tried to register" notice instead); `EMAIL_NOT_VERIFIED` only after a correct password. |
| Session theft / fixation | Opaque random token, HttpOnly + SameSite=Lax + Secure cookie; only its SHA-256 is stored; new token per login; idle + absolute expiry; revocation on logout, password change/reset and suspension. |
| CSRF | Double-submit token (`csrf_token` cookie ↔ `x-csrf-token` header, constant-time compare) + Origin/Referer allow-list + SameSite=Lax. |
| XSS | React escaping; no `dangerouslySetInnerHTML` with user data; CSP baseline; session cookie unreadable by JS; `nosniff`. |
| Clickjacking | `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'`. |
| Privilege escalation | Server-side permission checks on every route (`@RequirePermissions`); program scoping for PROGRAM_ADMIN (`assertProgramAccess`); admin routes require `mfaVerified`; no self-granting; only SUPER_ADMIN assigns roles; last SUPER_ADMIN protected. |
| Insider fraud (rewards) | Policies immutable once published; 50 % budget cap in DB; approvals by FINANCE_REVIEWER with segregation of duties (cannot approve own rewards); every privileged action audited (append-only); ledger append-only and balanced. |
| Referral manipulation | Attribution only at registration from a valid code of an ACTIVE, verified member; immutable outside the audited correction flow (trigger); cycle checks; shared-IP registration flags. |
| Data scraping / privacy leaks | Members see only privacy-filtered team data (first name + last initial, depth, join date, status bucket); never other members' email, phone, prices, rewards or sale amounts; DTOs map explicitly, never raw entities. |
| Injection | Zod validation on every input; Prisma parameterized queries; raw SQL only via tagged templates (`$queryRaw\`…${param}\``), never string-built. |
| DoS / abuse | nginx `limit_req`, body size 2 MB, header/body timeouts; API throttler (Redis-backed across replicas); pagination limits (max 100). |
| Secret leakage | Secrets only from environment; never in images, git or logs; log and audit redaction; OTPs stored as HMAC; email payload codes redacted after delivery. |
| Infrastructure compromise | Only nginx published; DB/Redis on an internal network without internet access; non-root containers, `cap_drop: ALL`, `no-new-privileges`, read-only root filesystems for API/worker; Redis password; pinned images. |

## 2. Authentication

- **Passwords:** ≥ 10 characters with at least one letter and one digit, hashed with
  **argon2id** (`argon2` library defaults or stronger). Hashes are never returned or logged.
  Password change requires the current password and revokes all sessions.
- **Login:** a generic `INVALID_CREDENTIALS` for an unknown email or a wrong password. 5
  consecutive failures set `locked_until = now + 15 min` (`ACCOUNT_LOCKED`, 423). Unverified
  accounts get `EMAIL_NOT_VERIFIED` only after a correct password. Suspended accounts get
  `ACCOUNT_SUSPENDED`.
- **Registration:** the same generic response whether or not the email exists, with no account
  enumeration.
- **Email OTP** (verification, admin MFA, password reset, email change):
  - 6 digits from a CSPRNG;
  - stored as `HMAC-SHA-256(OTP_PEPPER, purpose:email:code)`, never in plain text;
  - TTL 10 minutes, max 5 verification attempts (DB CHECK `attempts ≤ max_attempts`), single use;
  - a new code invalidates older open codes of the same purpose and email;
  - resend cooldown 60 s (`OTP_COOLDOWN`), max 5 sends per email and purpose per hour.
- **Admin MFA:** a login by any user with a non-MEMBER role gets a session with
  `mfa_verified=false` and an emailed `LOGIN_MFA` code. `/api/v1/admin/*` returns `MFA_REQUIRED`
  until it is verified. Hiding admin UI is never the control. The API guard is.
- **Password reset / email change:** OTP challenges. Email change requires the current password
  and verification of the new address, and the old address is notified.

## 3. Sessions

- Cookie `sid`: opaque 32-byte random token, `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when
  `COOKIE_SECURE=true` (default in `docker-compose.prod.yml`; required over HTTPS). Only
  `sha256(token)` is stored (`sessions.token_hash`).
- Absolute TTL 7 days (`SESSION_TTL_HOURS`), admins 12 h (`ADMIN_SESSION_TTL_HOURS`). Idle timeout
  12 h (`SESSION_IDLE_TIMEOUT_MINUTES`) from `last_seen_at`.
- Revocation: logout (that session); password change or reset and suspension (all sessions of
  the user). Expired sessions are rejected and later purged.
- IP and user agent are stored per session for the member's "active sessions" view and for
  investigations.

## 4. CSRF and CORS

- `GET /api/v1/auth/csrf` issues the `csrf_token` cookie (not HttpOnly, SameSite=Lax). Every
  mutating request (POST/PUT/PATCH/DELETE) must send it back in `x-csrf-token`. The values are
  compared in constant time.
- If `Origin` is present it must be an allowed origin (`APP_PUBLIC_URL` origin + `CORS_ORIGINS`).
  `Origin: null` is rejected. Without `Origin`, a present `Referer` must match. Failures →
  `403 CSRF_FAILED`.
- `@SkipCsrf()` is only for non-cookie callers, such as signed webhooks.
- Production is same-origin (nginx), so CORS is effectively closed: `CORS_ORIGINS` defaults to
  `APP_PUBLIC_URL`. `http://localhost:3000` is added only for local development.

## 5. Rate limits

| Layer | Scope | Limit |
|---|---|---|
| nginx | State-changing `/api/v1/auth/*` per IP (GET/HEAD/OPTIONS excluded) | 10 r/min, burst 20 → `429 RATE_LIMITED` (JSON, `Retry-After`) |
| nginx | All `/api/*` per IP | 20 r/s, burst 40 |
| API (throttler, Redis-backed when `THROTTLE_STORAGE=redis`) | `default` per IP | `THROTTLE_DEFAULT_LIMIT` / `THROTTLE_DEFAULT_TTL_SECONDS` (300 / 60 s) |
| API | `auth` routes (login, register, password reset) per IP | `THROTTLE_AUTH_LIMIT` / TTL (10 / 60 s) |
| API | `otp` routes (send/verify) per IP | `THROTTLE_OTP_LIMIT` / TTL (5 / 60 s) |
| API (domain, DB counters) | Per account/email | Login lockout (5 failures → 15 min), OTP attempts (5), OTP resend cooldown (60 s) and hourly send cap (5) |

The nginx allow-list (`infra/nginx/snippets/rate-limit-allowlist.conf`) is empty in production.
CI fills it only for the e2e runner.

## 6. HTTP security headers

| Header | Source | Value |
|---|---|---|
| `Content-Security-Policy` | nginx default (pages); helmet (API) | `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; …` (+ `upgrade-insecure-requests` under TLS) |
| `X-Content-Type-Options` | Next `headers()`, helmet, nginx default | `nosniff` |
| `Referrer-Policy` | Next, helmet, nginx default | `strict-origin-when-cross-origin` (helmet may use `no-referrer` for API responses) |
| `X-Frame-Options` | Next, nginx default | `DENY` |
| `Permissions-Policy` | Next, nginx default | camera, microphone, geolocation, payment, usb disabled |
| `Cross-Origin-Opener-Policy` | helmet, nginx default | `same-origin` |
| `Strict-Transport-Security` | nginx TLS server only | `max-age=63072000; includeSubDomains` (roll out gradually; `preload` only deliberately) |
| `Server` | nginx | `nginx` without version (`server_tokens off`); `X-Powered-By` stripped |

nginx adds each default **only if the upstream did not send that header**, so values are never
duplicated or contradictory.

**Why the CSP allows `'unsafe-inline'` scripts.** Next.js App Router injects inline bootstrap
scripts (`self.__next_f.push(...)`) and inline styles. A strict CSP needs a fresh nonce per
request, generated in Next.js `proxy.ts` and applied during server rendering. That forces dynamic
rendering of every page, which conflicts with the prerendered static shells of Cache Components
used by the web app. The baseline therefore keeps `'self'` for all other sources, disallows
plugins, framing and foreign form targets, and relies on React escaping plus the HttpOnly session
cookie. If the web app later adopts nonces, it sends its own `Content-Security-Policy` and nginx
automatically stops adding the default.

## 7. Authorization (RBAC)

- Roles are SUPER_ADMIN, PROGRAM_ADMIN, FINANCE_REVIEWER and MEMBER
  ([business-rules §3](business-rules.md#3-roles--permissions)). Permissions are keys in
  `@app/shared` (`Permission`, `ROLE_PERMISSIONS`), seeded into `roles` / `permissions` /
  `role_permissions`.
- Every route is protected unless marked `@Public()`. Admin routes declare
  `@RequirePermissions(...)`, checked server-side for each request against the session user's
  roles.
- **Program scoping:** PROGRAM_ADMIN permissions apply only to assigned programs
  (`program_admin_assignments`). Services call `assertProgramAccess(auth, programId)` for every
  program-scoped read and write, and list endpoints filter by assignment.
- **Segregation of duties:** a reviewer cannot approve or reject a reward of which they are the
  recipient. FINANCE_REVIEWER cannot edit programs or policies. Policy authors cannot approve
  rewards unless they also hold the reviewer role.
- **Role management:** only SUPER_ADMIN (`roles:assign`). Nobody can grant roles to themselves,
  and the last SUPER_ADMIN cannot be removed. Every grant and revoke is audited.
- **Object-level checks:** members access only their own resources (`/me/...`). IDs in URLs never
  bypass ownership checks. Use `404 NOT_FOUND` rather than `403` when revealing existence would
  leak information.

## 8. Audit

- `audit_logs` is append-only (DB trigger). The service writes `AuditService.record(tx, …)`
  **inside** the business transaction, so an action and its audit row commit together.
- Recorded: actor id and roles, action, resource type and id, redacted before/after, reason
  (required for suspensions, rejections, reversals, corrections and settings changes), request id
  and IP.
- Redaction: `redactForAudit` removes `password`, `passwordHash`, `newPassword`,
  `currentPassword`, `code`, `codeHash`, `token`, `tokenHash`, `otp`, `otpPepper` and `secret` at
  any depth. Never store OTPs, tokens or hashes in audit data.
- Must be audited: every admin mutation (settings, roles, offerings, programs and lifecycle,
  options, policies, enrollment decisions, member suspension and reactivation, referral
  corrections, event recording and reversal, reward approve/reject/reverse, flags, exports) and
  security-relevant member actions (password change, email change, deactivation).

## 9. Secrets management

| Secret | Notes |
|---|---|
| `OTP_PEPPER` | 64 hex chars (`openssl rand -hex 32`); production startup rejects anything else. Rotation invalidates only currently open codes (users request a new one). |
| `POSTGRES_PASSWORD` | Also embedded in `DATABASE_URL` by compose: use URL-safe values (hex). Rotate with `ALTER ROLE … PASSWORD`, then update `.env` and restart api/worker. |
| `REDIS_PASSWORD` | `requirepass`; embedded in `REDIS_URL`. |
| `SMTP_USER` / `SMTP_PASSWORD` | Provider credentials; use a sending-only key. |
| `SEED_SUPER_ADMIN_PASSWORD` | Used once by `db:seed`. Change the password after first login and remove it from `.env`. |

- Secrets come only from the environment (`.env` read by compose, or the orchestrator's secret
  store). `.env` is git-ignored and Docker-ignored, so it is never baked into an image.
- `docker-compose.prod.yml` contains no secrets; required ones use `${VAR:?…}`.
- The web container receives no secrets at all.
- Restrict `.env` file permissions (`chmod 600`) and backups that contain it.

## 10. Logging and redaction

- API logs are JSON (pino) with a `requestId` on every request-scoped line. The id comes from
  nginx's `X-Request-Id`, which is also returned in error bodies.
- Redacted paths: `authorization`, `cookie`, `x-csrf-token` and `set-cookie` headers, plus
  secret-like keys at any depth (`[redacted]`). Query strings are dropped from logged URLs.
- **Never log:** OTPs, passwords, tokens, cookies, hashes, full emails (log user ids instead, or a
  masked `j***@example.com`), or sale and reward amounts in combination with member PII outside
  the admin audit trail.
- nginx access logs are JSON. They log `$uri` (no query string), status, timings, upstream and
  `request_id`. Cookies and Authorization headers are never logged.
- Health probes are excluded from access logs.

## 11. Data protection

- Member team views follow business rules §6. The API selects only those columns, and UI
  filtering is never relied on.
- Referral codes are attribution, never authentication.
- Personal data stays in PostgreSQL (encrypted at rest by the storage layer or the managed
  service) and in backups. Encrypt backups and restrict their access (see
  [deployment.md](deployment.md#6-backup-and-restore)).
- Erasure requests anonymize PII instead of deleting rows, because financial and audit history
  must remain consistent (see [database.md](database.md#deletion-and-retention-policies)).

## 12. Compliance guardrails

Rewards come only from qualifying sales of approved offerings. The budget is capped at 50 % per
event (DB CHECK), there are no guaranteed-return claims, and there are no payouts
(`payouts_enabled = false`). These are security properties as much as business rules: they
cannot be changed through configuration ([ADR-0007](decisions/0007-sale-funded-rewards-budget-cap.md)).

## 13. Infrastructure and supply chain

- Containers run as non-root (`node`), with `cap_drop: ALL` and `no-new-privileges`. API, worker
  and migrate have read-only root filesystems with a `/tmp` tmpfs.
- Only nginx publishes a port. The `backend` network is `internal` (no internet). Only the worker
  has egress (SMTP).
- Images are built from `pnpm install --frozen-lockfile`. Dependency lifecycle scripts run only
  for the allow-listed packages in `pnpm-workspace.yaml` (`onlyBuiltDependencies`).
- Pin base images by major/minor version, rebuild regularly for OS patches, and scan images in CI
  (e.g. Trivy) before production use.

## 14. Production checklist

- [ ] HTTPS everywhere (TLS at nginx or the LB); `APP_PUBLIC_URL=https://…`; `COOKIE_SECURE=true`;
      HSTS enabled after verification.
- [ ] Unique random `OTP_PEPPER`, DB, Redis and SMTP credentials; `.env` mode 600; no
      `SEED_SUPER_ADMIN_PASSWORD` left after the first login.
- [ ] Client IPs are real: `TRUST_PROXY` = 1 hop behind the bundled nginx (pinned in the prod
      compose), and `set_real_ip_from` is configured for the LB's ranges if an LB sits in front.
- [ ] `THROTTLE_STORAGE=redis` when running more than one API replica.
- [ ] Rate-limit allow-list empty; Mailpit (`dev-mail` profile) not enabled.
- [ ] Backups encrypted, off-site and restore-tested; PITR configured if required.
- [ ] Log shipping with retention, and access restricted to operators.
- [ ] `payouts_enabled` remains false.
