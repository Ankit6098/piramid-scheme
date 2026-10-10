# ADR-0009: TOTP admin MFA and session rotation on elevation

- **Status:** Accepted (supersedes the "Admin MFA (email OTP)" section of [ADR-0005](0005-cookie-sessions-csrf-email-otp-mfa.md); sessions and CSRF from ADR-0005 stand)
- **Date:** 2026-10-10

## Context

ADR-0005 protected the admin area with an emailed one-time code. Admin accounts approve and
reverse rewards, record sales, publish policies, change roles and move members between sponsors,
so a compromised admin session directly affects member balances. An adversarial review found:

- **Email is a weak second factor for this blast radius.** Whoever controls the mailbox (or a
  forwarding rule, or a shared inbox) passes both "something you know" resets and the "second
  factor". Password reset and MFA would share one channel.
- **Elevation in place keeps the pre-MFA token.** If the second factor only flips a flag on the
  existing session row, a token captured before the second factor (shared machine, logged URL,
  fixation) becomes an elevated admin session the moment the real admin completes MFA.
- **A login code must elevate only the session that asked for it.** Otherwise a code requested
  by one browser could be redeemed by another session of the same account.

## Decision

1. **Every user holding a non-MEMBER role must enroll a TOTP authenticator** (RFC 6238: SHA-1,
   6 digits, 30 s step, ±1 step window). The secret is generated server-side (160 bits), shown
   once as an `otpauth://` URI, and stored in `user_mfa_factors.secret_enc` encrypted with
   AES-256-GCM (`MFA_ENCRYPTION_KEY`, AAD `user_mfa_factors:<userId>`). A factor is unconfirmed
   until the first valid code (setup expires after 30 minutes). At most one live factor per user
   (partial unique index `uq_mfa_factors_one_active`).
2. **Replay protection:** each accepted code stores its time step in `last_used_step` with a
   conditional UPDATE (`… WHERE last_used_step IS NULL OR last_used_step < $step`), so a code (or
   an older one) is accepted at most once, even under concurrent requests.
3. **Admin access is a per-request computation, not a flag:**
   `adminAccess = isAdmin ∧ session.mfaMethod = 'TOTP' ∧ mfaVerifiedAt within 12 h`
   (`computeAdminAccess`). `SessionAuthGuard` applies it to every `/api/v1/admin/**` route:
   403 `MFA_REQUIRED` with `details.reason` `TOTP_ENROLLMENT_REQUIRED` or `TOTP_REQUIRED`.
   Roles, permissions and factors are re-read on every request.
4. **Bootstrap without a factor:** the first admin login gets an email code bound to the session
   (`LOGIN_MFA`; DB CHECK `ck_email_challenges_mfa_session` requires `session_id`). Verifying it
   marks the session `EMAIL_OTP`, which only unlocks TOTP setup. **Email OTP never grants admin
   access.**
5. **Login never elevates.** `POST /auth/login` creates a session without a second factor (admin
   TTL 12 h) and answers `{ mfaRequired: true, method: 'TOTP' | 'TOTP_ENROLLMENT' }`. The member
   area works without MFA; only `/admin/**` needs it.
6. **Every successful MFA step rotates the session** (`SessionTokenService.elevateSession`): in
   the transaction that accepts the factor, insert a new session row with a new random token,
   `mfa_method`, `mfa_verified_at = now`, the same IP/user agent and
   `expires_at = least(old.expires_at, now + 12 h)`; revoke the old row with `mfa_rotated` using a
   conditional UPDATE (two concurrent elevations cannot both win); set the new cookie. DB CHECK
   `ck_sessions_mfa`: `mfa_method` and `mfa_verified_at` are set together.
7. **Changing the factor:** `POST /users/me/mfa/totp/reset` requires a current code, revokes the
   factor and every other session, and notifies all SUPER_ADMINs; the admin then enrolls again.
   Self-service password reset is disabled for admin-role users (a SUPER_ADMIN sends an audited
   admin-triggered reset instead — business rules §2), and password or email changes of an admin
   notify all SUPER_ADMINs.
8. TOTP confirm/verify/reset failures share the Redis login backoff (per email-HMAC + IP and per
   IP) in addition to the `otp` throttler.

## Consequences

- Admin access needs possession of the enrolled device; mailbox compromise alone no longer
  reaches the admin area, and password reset cannot be chained into it.
- A token observed before the second factor is worthless afterwards: the elevated session has a
  different token, and the old row is revoked.
- Admin sessions re-verify at least every 12 hours (absolute TTL and MFA age), so a stolen elevated
  cookie has a bounded lifetime.
- `MFA_ENCRYPTION_KEY` becomes a critical secret. Rotating it currently means re-enrolling every
  authenticator (there is no re-encryption tool yet). It must differ from `OTP_PEPPER` and
  `OTP_OUTBOX_KEY` (enforced at startup).
- **No self-service recovery for a lost device** (no recovery codes yet). Today an operator
  revokes the factor out of band (`UPDATE user_mfa_factors SET revoked_at = now() WHERE user_id = …`,
  recorded in the change log), after which the admin re-enrolls through the email bootstrap. A
  SUPER_ADMIN-initiated, audited reset endpoint and recovery codes are the planned follow-ups.
- The web app must handle `MFA_REQUIRED` reasons and route admins through `/mfa` (enrollment with a
  QR code, or verification) before showing admin pages.
- Tests create elevated sessions directly (`loginAs(t, user, { mfa: 'TOTP' })` uses
  `elevateSession`), so every admin integration test exercises the rotation path.

## Alternatives considered

- **Keep email OTP for admins (ADR-0005):** simplest onboarding, but it shares a channel with
  password reset and is weak against mailbox compromise.
- **WebAuthn / passkeys:** phishing-resistant and the best long-term option, but it needs
  browser-specific UX, attestation choices and a recovery story. TOTP is a deliberate first step;
  the factor table (`kind`) leaves room for WebAuthn later.
- **SMS codes:** SIM-swap and interception risks, cost, and a phone number dependency.
- **Flag the existing session as verified instead of rotating:** fewer rows, but it keeps the
  pre-MFA token valid as an elevated credential (session fixation).
