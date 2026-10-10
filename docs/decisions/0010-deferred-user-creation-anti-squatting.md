# ADR-0010: Deferred user creation at registration (anti-squatting)

- **Status:** Accepted
- **Date:** 2026-10-10

## Context

The first design created a `users` row with status `PENDING_VERIFICATION` at `POST /auth/register`,
together with the sponsor relationship and closure rows, and activated it when the email code was
verified. An adversarial review showed that in a referral product this is exploitable:

- **Email squatting.** Anyone can register someone else's address. The unique `email` then blocks
  the real owner, or forces a "this address is taken" message that also enumerates accounts.
- **Attribution hijacking.** Attribution decides who earns from a member's future sales. If the
  pending row already carries a sponsor, the squatter chooses the sponsor (their own downline) for
  a person who never agreed; when the owner later claims the address (verification, password
  reset), they are already placed in the attacker's tree.
- **Tree pollution.** Unverified rows appear in the closure table, in team counts and in fraud
  heuristics, and must be cleaned up with deletes that the tree triggers are designed to forbid.

## Decision

1. **`POST /auth/register` never creates a user.** It validates the referral code, hashes the
   password (argon2id, always, so timing is equal), and in one transaction (advisory lock per
   address and purpose):
   - if the address already has an account: sends the owner a de-duplicated "someone tried to
     register" notice and nothing else;
   - otherwise: invalidates any older open challenge and inserts an `EMAIL_VERIFICATION` challenge
     carrying the **pending payload** (`pending_full_name`, `pending_password_hash`,
     `pending_referral_code_id`), then emails the code through the OTP outbox.

   The response is the same `202` in both cases.
2. **The account is created only by the transaction that verifies the code** (`POST /auth/verify-email`
   with the code **and the password chosen at registration**). The code attempt is counted
   atomically, then the password is verified with argon2 against the pending hash on every path (a
   dummy hash when the code was wrong); a wrong password is the same `400 OTP_INVALID` as a wrong
   code and counts as a failed attempt. Then, in one transaction:
   consume the challenge → insert the user as `ACTIVE` with a verified email → re-validate the
   stored referral code (if it is no longer valid, the member joins without a sponsor and the
   response says so) → `ReferralsService.attachNewMember` (shared tree lock, self row,
   relationship with registration IP/user agent, ancestor rows, own code) → `MEMBER` role →
   session → audit `user.register`. One transaction, no savepoints.
3. **The database makes the old pattern impossible:**
   - `ck_users_active_verified`: an ACTIVE user always has `email_verified_at`;
   - `ck_email_challenges_pending_payload`: a pending payload exists only on an
     `EMAIL_VERIFICATION` challenge with no `user_id`;
   - `uq_email_challenges_one_open`: one open challenge per (address, purpose), so a newer
     registration replaces the older pending one;
   - the referral insert guards accept a relationship or closure row only for a user **created in
     the same transaction** (`xmin`) under the tree lock, so nobody can attach an existing member
     to a sponsor afterwards (only the audited correction protocol can move members).
4. **Lifecycle of pending data:** a newer registration for the same address supersedes the pending
   one (within the hourly cap; a refused registration still invalidates the older payload).
   `auth-challenge-cleanup` scrubs payloads 24 h after the challenge was consumed, invalidated or
   expired, and deletes challenge rows after 30 days. One-time-code limits (cooldown, hourly cap,
   24 h failure block) apply and are silent on this public flow.

## Consequences

- Only the mailbox owner can create an account for an address and bind it to a sponsor. Squatting
  and attribution hijacking are impossible, and registration does not reveal whether an address
  is registered.
- The referral tree, team counts and fraud signals contain only verified members.
- `PENDING_VERIFICATION` remains in the enum for legacy rows only; new code never writes it.
- An argon2id hash of the pending password is stored on the challenge until ~24 h after it stops
  being usable, then scrubbed by the cleanup job. It is never copied into audit or outbox payloads
  (DB CHECKs reject password-like keys there).
- **Residual risk (closed 2026-10):** someone else can start a registration for your address and
  you receive a code you did not request. Verification now also requires the password of that
  registration (argon2 verify against the pending hash, same generic `OTP_INVALID`, counted as a
  failed attempt), so entering the code with your own password never creates an account with
  *their* password and sponsor; the owner registers again (which replaces the pending one) and
  verifies with their own password.
- Registration and verification are two requests with state held in `email_challenges`; the web
  app carries only the address from the register page to the verify page (sessionStorage).

## Alternatives considered

- **Create a `PENDING_VERIFICATION` user without attribution and attach the sponsor at
  verification:** removes hijacking but keeps squatting on the unique email, enumeration, and
  unverified rows that must later be deleted.
- **Allow re-registration to overwrite a pending user:** races between two registrations for one
  address, and tree rows for users that may be deleted again, which the append-only tree design
  forbids.
- **Magic-link verification:** same deferral, but links leak through logs, previews and
  referrers more easily than a short code with attempt limits.
