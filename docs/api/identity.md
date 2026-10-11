# Identity API — auth & self-service account

Slice 1 (identity). Base path `/api/v1`. Business rules: [business-rules.md §2](../business-rules.md#2-accounts--authentication).
Schemas: `packages/shared/src/contracts/auth.ts` and `contracts/users.ts`. Every mutation needs the CSRF
double-submit pair (`csrf_token` cookie ↔ `x-csrf-token` header, from `GET /auth/csrf`, core-owned).

Conventions used below:

- **Auth** — `public` (no session), `optional` (works with or without a session), `session` (any
  signed-in user), `admin session` (signed-in user with a non-MEMBER role; admin *access* not needed).
- **Limit** — `auth` / `otp` = per-IP Nest throttlers (`THROTTLE_AUTH_*`, `THROTTLE_OTP_*`); `login` = the
  Redis login backoff (`LoginThrottleService`, per email-HMAC + IP and per IP); `codes` = the DB-derived
  one-time-code limits below.
- Errors use the standard envelope `{ error: { code, message, details?, requestId } }`. Validation errors are
  `400 VALIDATION_FAILED` with `details.issues[] = { path, message, code }`.

## One-time codes (email)

6 digits (CSPRNG), stored only as `HMAC-SHA-256(OTP_PEPPER, purpose:email:code)`, TTL 10 min, 5 attempts per
code, single use, one open challenge per (address, purpose) — issuing a new code invalidates the previous one
in the same transaction. Delivery only via `OtpMailer` (outbox payload `{ challengeId, codeCiphertext,
template }`, scrubbed when SENT/DEAD). Limits per (address, purpose), derived from `email_challenges`:

| Limit | Value | Public flows (register, resend, forgot, email change) | Admin email MFA, admin-triggered reset |
|---|---|---|---|
| Resend cooldown | 60 s | silent (same 202) | `429 OTP_COOLDOWN` + `Retry-After` |
| Codes per hour | 5 | silent | `429 RATE_LIMITED` + `Retry-After` |
| Failed attempts in 24 h | ≥ 10 → sends **and** verifications blocked for 24 h; owner emailed once/day | silent / generic `OTP_INVALID` | `429 OTP_TOO_MANY_ATTEMPTS` |

Every failed verification (wrong, expired, used, exhausted, blocked, no code at all) returns the same
`400 OTP_INVALID` with the same message. A new **registration** for an address always supersedes the pending
one (no cooldown, but within the hourly cap); if refused by a limit, the older pending payload is invalidated
so it can never be verified.

## Auth (`/auth`)

### `POST /auth/register` — public · limit `auth` · `202`

Request `{ fullName (2–120, no control characters, no web addresses — `://` / `www.`), email, password (≥ 10, a
letter + a digit), referralCode? }` (email trimmed + lower-cased; empty `referralCode` = none).

Never creates a user. Validates `referralCode` (`ReferralsService.resolveCodeForRegistration`), hashes the
password (argon2id — always, for equal cost), then in one transaction (advisory lock per address): if the
address has an account → a de-duplicated (1/hour) *registration-attempt* notice to the owner; otherwise the
pending name, password hash and referral code are stored on a new `EMAIL_VERIFICATION` challenge (the older
open one is invalidated and scrubbed) and the code is emailed. The verification email never greets by name: the
pending name is unverified input anybody can type for any address.

Response (identical for known and unknown addresses):
`{ data: { accepted: true, message, expiresInSeconds: 600, resendAfterSeconds: 60 } }`.
Errors: `400 REFERRAL_CODE_INVALID` (code unknown/inactive/owner not ACTIVE+verified), `400 VALIDATION_FAILED`.

### `POST /auth/register/resend` — public · limit `otp` · `202`

`{ email }` → same generic body. Re-issues a code for a pending registration (payload copied, `sendCount + 1`,
old challenge invalidated) subject to the code limits — all refusals are silent. Pending registrations can be
re-sent until 24 h after their last code expired (then scrubbed by `auth-challenge-cleanup`).

### `POST /auth/verify-email` — public · limit `otp` · `200` · sets `sid` + new `csrf_token`

`{ email, code, password }` — `password` is the one chosen at registration (any non-empty string ≤ 256; the
strength rules were applied at registration). Atomic attempt (`UPDATE … attempts + 1 … RETURNING`,
constant-time compare), then **one argon2 verification of `password` against the pending hash on every path**
(a dummy hash when the code was wrong or the address is blocked, so timing does not reveal whether the code
was right). A wrong password returns the same `400 OTP_INVALID` as a wrong code and stays a failed attempt
(the challenge is not consumed; it counts towards the 5-per-code and 10-per-24 h limits). A code from somebody
else's registration for your address therefore never creates an account with their password — register
again (the newer registration replaces theirs) and verify with your own. Then ONE transaction without
savepoints: consume the challenge (conditional) → create the user (`ACTIVE`, verified,
pending password hash) → re-validate the stored referral code (if no longer valid: join as a root member and
report it) → `ReferralsService.attachNewMember` (shared tree lock, self row, relationship with registration
IP + user agent, ancestor rows, own referral code) → `MEMBER` role → session (member TTL) → audit
`user.register` (actor = new user; `sponsorUserId`, `referralCodeNoLongerValid`). A session cookie presented
with the request is revoked.

Response `{ data: { user: SessionUserDto, referral: { applied, codeNoLongerValid } } }`.
Errors: `400 OTP_INVALID` (wrong/expired/used code **or** wrong password), `400 VALIDATION_FAILED`
(missing `password`, malformed code/email).

### `POST /auth/login` — public · limits `auth` + `login` · `200` · sets `sid` + new `csrf_token`

`{ email, password }`. Unknown email (dummy argon2 verify) and wrong password → `401 INVALID_CREDENTIALS`
(same message, same throttle counters, no cookie). After 5 failures per (email, IP) — 20 per IP — each further
attempt is blocked 30 s · 2^k (max 15 min): `429 RATE_LIMITED` + `Retry-After`, even with the right password;
other IPs are unaffected. Only after a correct password: `403 ACCOUNT_SUSPENDED` (suspended or deactivated),
`403 EMAIL_NOT_VERIFIED` (legacy). Success creates a session **without** a second factor (admin TTL 12 h for
admin roles, else 7 days), updates `lastLoginAt`, audits `auth.login`, revokes a session presented with the
request. The transaction proceeds only while the account still holds the hash that was verified and is ACTIVE
(conditional UPDATE of `lastLoginAt` + optional argon2 rehash): a password reset/change or suspension that
commits during the login wins → `401 INVALID_CREDENTIALS`, and a rehash never overwrites a newer password.

Response `{ data: { mfaRequired: false, user } }` for members;
`{ data: { mfaRequired: true, method: 'TOTP' | 'TOTP_ENROLLMENT', user } }` for admin-role users (TOTP when a
confirmed authenticator exists, else enrollment). The member area works without MFA; `/admin/*` needs it.

### `POST /auth/logout` — optional · `200`

Revokes the current session (`logout`, audited) or whatever session the cookie names; clears `sid`, issues a
fresh `csrf_token`. `{ data: { signedOut: true } }`.

### `GET /auth/session` — optional

`{ data: { user: SessionUserDto } }`; `401 UNAUTHENTICATED` without a valid session (a dead cookie is cleared).

```ts
SessionUserDto = { id, fullName, email, emailVerified, avatarUrl, roles, permissions, isAdmin,
                   adminAccess, mfaMethod: 'EMAIL_OTP' | 'TOTP' | null, hasTotpFactor }
```

### `POST /auth/password/forgot` — public · limit `auth` · `202`

`{ email }` → generic body. ACTIVE members get a `PASSWORD_RESET` code (limits silent). **Admin-role users:**
same 202, no email; every ACTIVE SUPER_ADMIN gets an email + in-app notice (1/hour per account, masked
address) and `auth.password_reset.blocked_admin` is audited — a SUPER_ADMIN can then send an admin-triggered
reset (below). Unknown/suspended addresses: nothing.

### `POST /auth/password/reset` — public · limit `auth` · `200`

`{ email, code, newPassword }`. Code verified atomically; then one transaction: consume → (refused, code
still consumed, if the account changed address or is not ACTIVE, or holds an admin role and the code was
not an admin-triggered one — see below) → new hash + `passwordChangedAt` → **all** sessions revoked
(`password_reset`) → audit `user.password.reset` (`after = { adminInitiated: true, initiatedByUserId }` for
admin-triggered codes) → owner notice (+ every SUPER_ADMIN for admin accounts). Does not sign in.
`{ data: { passwordReset: true } }`. Errors: `400 OTP_INVALID`, `400 VALIDATION_FAILED`.

**Admin-triggered codes.** `POST /admin/members/:id/password-reset` (SUPER_ADMIN, see
[adminops.md](adminops.md#members)) issues the code through `AuthService.issueAdminPasswordReset`: same
challenge table, limits and OTP delivery, but the challenge records the issuing SUPER_ADMIN session in
`session_id` (null for self-service codes). For an admin-role account a code is accepted only when that
session belongs to an ACTIVE SUPER_ADMIN other than the account itself — so a code requested while the
account was still a plain member, or issued by someone who has since lost the role, is refused.

## Admin MFA (`/auth/mfa`) — admin session

Every success **rotates** the session (`SessionTokenService.elevateSession`: new token/row with
`mfaMethod`/`mfaVerifiedAt`, expiry ≤ now + 12 h, old row revoked `mfa_rotated`) and sets the new `sid`.
Members get `403 FORBIDDEN`; no session → `401`.

| Method & path | Limit | Preconditions | Effect / response |
|---|---|---|---|
| `POST /auth/mfa/email/send` | `otp`, codes | no confirmed authenticator, session not yet MFA'd | `LOGIN_MFA` code bound to THIS session → `{ sentTo (masked), expiresAt, resendAfterSeconds }`. `409 INVALID_STATE_TRANSITION` if an authenticator exists / already verified, or when the account's email was changed (re-verified) after this session signed in (sign in again); `429 OTP_COOLDOWN \| RATE_LIMITED \| OTP_TOO_MANY_ATTEMPTS` |
| `POST /auth/mfa/email/verify` `{ code }` | `otp`, codes | as above | elevates with `EMAIL_OTP` (never admin access) → `{ user }`. Only a code requested by this session matches. `400 OTP_INVALID`; `409` as above when the email changed after sign-in |
| `POST /auth/mfa/totp/setup` | `otp` | no confirmed authenticator; session MFA'd (`EMAIL_OTP`, or `TOTP` after a reset) | new secret, stored AES-256-GCM encrypted as an unconfirmed factor (older unconfirmed one revoked) → `{ otpauthUri, secret, issuer, accountName }` (shown once). `403 MFA_REQUIRED` before the email step; `409` if already enrolled |
| `POST /auth/mfa/totp/confirm` `{ code }` | `otp`, `login` | pending factor < 30 min old | factor confirmed (`last_used_step` set) + elevated with `TOTP` → `{ user }` with `adminAccess: true`. `400 OTP_INVALID`; `409` setup expired; `429 RATE_LIMITED` (per-account lockout, see below) |
| `POST /auth/mfa/totp/verify` `{ code }` | `otp`, `login` | confirmed authenticator | replay-safe (`… WHERE last_used_step IS NULL OR last_used_step < step`) → elevated with `TOTP` → `{ user }`. `400 OTP_INVALID` (wrong or replayed); `403 MFA_REQUIRED` (`details.reason = TOTP_ENROLLMENT_REQUIRED`) without a factor; `429 RATE_LIMITED` after repeated failures (per (user, IP) / IP backoff, or the per-account lockout) |

**Per-account authenticator lockout.** Besides the login backoff (per (user, IP) and per IP), wrong codes on
`/auth/mfa/totp/verify`, `/auth/mfa/totp/confirm` and `/users/me/mfa/totp/reset` count against the ACCOUNT,
whatever the client IP: the 10th consecutive failure pauses TOTP verification for that account for 15 min
(each further failure after a pause doubles it, max 24 h; a correct code resets the counter; counters expire
24 h after the last failure or pause). The failure that locks returns `429 RATE_LIMITED` (`retryAfterSeconds`)
and revokes the calling session (`totp_locked`); the first lock of an episode is audited
(`auth.mfa.totp_locked`) and notifies the owner (email + in-app) and every SUPER_ADMIN (once per day). While
paused, every TOTP route answers `429` — also with the right code.

Audit: `auth.mfa.email_verified`, `auth.mfa.totp_setup_started`, `auth.mfa.totp_enrolled`,
`auth.mfa.totp_verified`, `auth.mfa.totp_locked`.

## Self-service account (`/users/me`) — session

All routes act only on the caller's account.

| Method & path | Limit | Request | Response / behaviour |
|---|---|---|---|
| `GET /users/me` | — | — | `ProfileDto { id, fullName, email, emailVerifiedAt, phone, avatarUrl, createdAt, lastLoginAt, passwordChangedAt, roles, isAdmin, hasTotpFactor, totpEnrolledAt }` |
| `PATCH /users/me` | — | `{ fullName?, phone?: string \| null, avatarUrl?: https URL \| null }` (≥ 1 field) | updated `ProfileDto`; audit `user.profile.update` with only the changed fields (phone masked); no-op → no audit |
| `POST /users/me/password` | `auth`, `login` | `{ currentPassword, newPassword }` (must differ) | `ProfileDto`; other sessions revoked (`password_changed`), open reset codes voided, owner notice, SUPER_ADMINs notified for admins; audit `user.password.change`. Wrong current password → `400 VALIDATION_FAILED` on `currentPassword` (shares the login backoff) |
| `POST /users/me/email-change` | `otp`, `login`, codes | `{ newEmail, password }` | `202` generic body — identical when `newEmail` belongs to another account (that address gets a notice instead of a code); audit `user.email_change.requested` either way. `400` on `password` / `newEmail` (same as current). **Admin-role accounts:** `403 MFA_REQUIRED` (`details.reason`) unless the session is TOTP-verified (`adminAccess`) — checked before the password |
| `POST /users/me/email-change/confirm` | `otp`, codes | `{ code }` | `ProfileDto` with the new email; other sessions revoked (`email_changed`), the account's open codes voided, OLD address gets `email-changed-notice` (+ in-app), SUPER_ADMINs notified for admins; audit `user.email.change` (masked). `400 OTP_INVALID`; `409 CONFLICT` if the address was taken meanwhile; `403 MFA_REQUIRED` for an admin-role account without `adminAccess` (also when the role was granted after the change started) |
| `GET /users/me/sessions` | — | `?cursor&limit` | page of `UserSessionDto { id, createdAt, lastSeenAt, expiresAt, ipAddress, userAgent, mfaMethod, current }` — open sessions only (not revoked/expired/idle), newest first |
| `DELETE /users/me/sessions/:id` | — | — | `{ revoked: true, current }`; another account's session → `404`; revoking the current one clears `sid`; audit `user.session.revoke` |
| `POST /users/me/sessions/revoke-others` | — | — | `{ revoked: n }`; audit `user.sessions.revoke_others` |
| `GET /users/me/activity` | — | `?cursor&limit` | page of `ActivityEntryDto { id, action, resourceType, createdAt, ipAddress (masked, e.g. 203.0.113.x) }` — entries the caller performed or about the caller's account; no before/after, no actor ids |
| `POST /users/me/mfa/totp/reset` | `otp`, `login` | `{ code }` (current authenticator code) | admins only (`403 FORBIDDEN` otherwise). Factor revoked (replay-safe), other sessions revoked (`mfa_reset`), SUPER_ADMINs notified; audit `user.mfa.totp_reset` → `ProfileDto`. Then enroll again via `/auth/mfa/totp/setup`. Wrong codes count against the per-account lockout (`429`) |

There is deliberately no "pending email change" field in `ProfileDto`: it would reveal whether the requested
address is already taken.

## Background jobs

| Job | Schedule | Work |
|---|---|---|
| `auth-challenge-cleanup` | every 15 min | scrubs pending registration payloads (name, password hash, referral code) of challenges consumed, invalidated or expired > 24 h ago; deletes challenge rows older than 30 days |
| `auth-session-cleanup` | 03:41 daily | deletes sessions expired or revoked more than 30 days ago |

## Residual risks (documented decisions)

- A registration started by someone else for your address still emails you a code (we cannot tell who is
  registering). The code alone is useless: verification also needs the password of *that* registration, so
  entering it with your own password fails and you simply register again. Repeated foreign registrations can
  delay yours only within the hourly code cap.
- Self-service password reset is off for admin-role accounts; recovery depends on another SUPER_ADMIN
  sending an admin-triggered reset (the last remaining SUPER_ADMIN cannot reset themselves this way — keep at
  least two).
- `POST /auth/mfa/totp/*` failures share the per-IP login backoff budget (20 free failures per IP).
