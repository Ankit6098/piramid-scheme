# ADR-0005: Cookie sessions, CSRF double-submit, email-OTP admin MFA

- **Status:** Accepted. The "Admin MFA (email OTP)" section is superseded by [ADR-0009](0009-totp-admin-mfa-session-rotation.md) (TOTP for admin access, session rotation on elevation); email OTP remains only as the first-login bootstrap.
- **Date:** 2026-10-09

## Context

A browser-only product with a same-origin API (ADR-0008). Admin accounts can approve rewards,
reverse ledger postings and change referral attribution, so their sessions need a second factor.
Requirements from [business-rules.md §2](../business-rules.md#2-accounts--authentication):

- immediate revocation (logout, password change or reset, suspension);
- idle and absolute timeouts, shorter for admins;
- no tokens readable by JavaScript.

## Decision

**Sessions**

- On login the API creates an opaque **32-byte random token**. Only its **SHA-256** is stored in
  `sessions.token_hash`. The raw token goes into the `sid` cookie: `HttpOnly`, `SameSite=Lax`,
  `Path=/`, and `Secure` when `COOKIE_SECURE=true` (always in production over HTTPS).
- Absolute TTL 7 days (`SESSION_TTL_HOURS`); admins 12 h (`ADMIN_SESSION_TTL_HOURS`). Idle timeout
  12 h (`SESSION_IDLE_TIMEOUT_MINUTES`), computed from `last_seen_at`.
- Revocation sets `revoked_at` and `revoke_reason`. It happens on logout, on every password
  change or reset (all sessions), on suspension (all sessions), and when expired.
- Every request is authenticated server-side by hash lookup. There is no JWT and nothing in
  `localStorage`.

**CSRF**

- **Double-submit token:** `GET /api/v1/auth/csrf` sets a random `csrf_token` cookie (readable by
  the SPA, not HttpOnly). Mutating requests must echo it in `x-csrf-token`. The comparison is
  constant-time.
- **Origin check:** when `Origin` (or else `Referer`) is present it must be an allowed origin
  (`APP_PUBLIC_URL` + `CORS_ORIGINS`). `Origin: null` is rejected.
- `SameSite=Lax` on `sid` is a third layer. `@SkipCsrf()` is reserved for non-cookie callers,
  such as signed webhooks.

**Admin MFA (email OTP)**

- Logging in to an account that holds any non-MEMBER role creates a session with
  `mfa_verified=false` and emails a `LOGIN_MFA` code. `/api/v1/admin/*` requires
  `mfa_verified=true` (`MFA_REQUIRED` otherwise).
- OTPs are 6 digits from a CSPRNG and stored as `HMAC-SHA-256(OTP_PEPPER, purpose:email:code)`.
  They have a 10-minute TTL, at most 5 attempts and single use. A new code invalidates the open
  ones. The resend cooldown is 60 s, with at most 5 sends per email and purpose per hour.

## Consequences

- XSS cannot exfiltrate the session (HttpOnly). CSRF needs the token, a matching origin and a
  Lax-permitted request.
- Sessions are revocable instantly and auditable (IP and user agent stored), at the cost of one
  indexed lookup per request.
- The same-origin deployment keeps cookies first-party. Cross-site embedding and third-party
  cookie restrictions are non-issues.
- Email OTP depends on mail deliverability (outbox and worker retries). It is weaker than
  TOTP/WebAuthn against mailbox compromise. Stronger factors can be added later as additional
  challenge purposes without changing sessions.
- Rotating `OTP_PEPPER` invalidates only open codes (users request new ones). It does not affect
  sessions.

## Alternatives considered

- **JWT access + refresh tokens:** stateless, but revocation needs a denylist anyway. Storing
  tokens in JS-readable storage widens the XSS blast radius.
- **SameSite=Strict only, no CSRF token:** breaks top-level navigations from email links into an
  authenticated state, and relies on a single browser mechanism.
- **TOTP / WebAuthn for admins now:** better security, more onboarding and recovery flows. It is
  deferred, and the challenge model leaves room for it.
