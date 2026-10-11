# Business Rules

Authoritative domain rules. Code, tests and UI copy must agree with this document. When a rule
changes, update this file in the same change. Items marked **[DB]** are also enforced by database
constraints/triggers (`apps/api/prisma/migrations/*_integrity_constraints`), so the application must
validate first and turn violations into friendly errors.

## 0. Compliance guardrails (fixed, not configurable)

1. **Rewards are funded only by sales of an approved Offering to an end customer.** Trigger types:
   `PRODUCT_SALE`, `SERVICE_COMPLETED`, `SUBSCRIPTION_RENEWAL` (an *end customer's* renewal of the
   Offering). Registration, referral and enrollment are never triggers. **A member's own payment for a
   program Option (initial or renewal) — or a recruit's — never funds rewards.** A sale *resembles* a plan
   payment when the amounts are equal, the payment was made in a program with the sale's currency (any
   program, not only the sale's), and it was recorded within ±2 days of the sale's `occurredAt` **or** of
   the time the sale is recorded (so back-dating cannot escape the window):
   - an event whose external id equals any enrollment payment reference (references are unique across
     programs), or that resembles the **subject's own** plan payment, is rejected [DB: insert guard];
   - one that resembles a plan payment by a member of the **subject's downline** (any depth) is not
     refused — an honest sale can match by coincidence — but it is flagged: its rewards are **never
     auto-approved** (always `PENDING_APPROVAL`, even for API sales under a no-approval policy) [DB:
     `trg_rewards_lookalike_guard`], an OPEN `PLAN_PAYMENT_LOOKALIKE` flag (dedupe key
     `PLAN_PAYMENT_LOOKALIKE:<eventId>`) is raised on the subject, reviewers see the warning on the sale,
     the reward detail and the approval dialogs, and the sale is queued in reconciliation (§11).

   Every sale names an end-customer reference.
2. **Budget cap.** Rewards for one sale ≤ `budgetBps` of the sale value and `budgetBps ≤ 5000` (50%)
   [DB: on policies *and* on every stored calculation; Σ rewards = calculation total].
3. **No guaranteed returns.** The UI never shows projected or guaranteed income. Option prices are the
   price of the offering's plan, not a deposit, and earn nothing.
4. **No payouts.** The ledger records reward liabilities only. `payoutsEnabled` is pinned to false
   [DB CHECK]; enabling it requires a reviewed migration after legal/KYC/payment-provider approval.
5. **Four eyes on money.** Rewards from manually recorded sales always need a second person to approve
   them (see §3, §9).

## 1. Platform settings & currencies

- `currencies` table (ISO 4217 code ↔ minor units) is reference data seeded by migration [DB immutable].
- Singleton settings: `rewardUnit` (`MONEY` | `POINTS`) = default for new programs and the global display
  mode; `currencyCode` (+ its minor units via FK); `pointsLabel`; default `pointsPerCurrencyUnit` and
  default `budgetBps` for new policy drafts. Only SUPER_ADMIN (`settings:write`), with a reason, audited;
  optimistic `version` [DB bumps it].
- Changing `currencyCode` is blocked while any SCHEDULED/ACTIVE/PAUSED program uses another currency [DB].
- A program snapshots `rewardUnit`, `currencyCode`, `currencyMinorUnits` at creation; frozen after
  publication [DB]. A policy version snapshots `pointsPerCurrencyUnit`; frozen once published [DB].
  Every calculation stores the unit, currency, minor units and points rate it used.
- Amounts are always rendered from the record's own stored unit/currency through `formatAmount()`; the
  live settings are only the default for things that have no stored unit (e.g. empty states, forms).

## 2. Accounts & authentication

- Email normalized (trim + lower-case), unique. Statuses: `ACTIVE` (requires a verified email [DB]),
  `SUSPENDED` (admin, reason), `DEACTIVATED`. (`PENDING_VERIFICATION` is legacy-only: accounts are now
  created already verified, see Registration.)
- Password: ≥ 10 chars with a letter and a digit; argon2id.
- Full name: 2–120 chars, no control characters, no web addresses (`://`, `www.`) — names appear in emails and
  other members' team views.
- **Registration (anti-squatting):** `POST /auth/register` never creates a user. It stores the pending
  name, password hash and validated referral code on an `EMAIL_VERIFICATION` challenge and emails a code.
  The users row, depth-0 closure row, sponsor relationship and ancestor rows are created in the single
  transaction that verifies the code, after re-validating the referral code (owner ACTIVE + verified).
  Only the mailbox owner can therefore attach an address to a sponsor. Verification requires the code
  **and the password chosen at registration** (argon2 verify against the pending hash; one argon2
  verification on every path, so a wrong password is indistinguishable from a wrong code: same generic
  `OTP_INVALID`, counted as a failed attempt). A code from somebody else's registration for your address
  therefore never activates an account with their password — the owner registers again (a newer
  registration for the same address replaces the older pending one) and verifies with their own. For an
  address that already has an account the response is identical and the owner gets a "someone tried to
  register" notice. The verification email never greets by name (the pending name is unverified input).
- **OTP codes:** 6 digits (CSPRNG); stored only as HMAC-SHA-256(pepper, `purpose:email:code`); TTL 10
  min; ≤ 5 attempts per code; single use; **one open challenge per (email, purpose)** [DB] — issuing a
  new code invalidates the old one in the same transaction; resend cooldown 60 s; ≤ 5 sends per hour;
  **cumulative cap:** ≥ 10 failed attempts for an (email, purpose) in 24 h blocks further sends and
  verifications for 24 h (same generic responses) and notifies the owner. Verification is atomic
  (`UPDATE … SET attempts = attempts + 1 WHERE … AND attempts < max_attempts RETURNING`, constant-time
  compare, consume with a conditional UPDATE).
- **OTP delivery:** the outbox payload carries only `{challengeId, codeCiphertext}` (AES-256-GCM with
  `OTP_OUTBOX_KEY`, AAD = challengeId). The worker decrypts, checks the challenge is still open, sends,
  and removes the ciphertext in the same UPDATE that marks the message SENT/DEAD [DB checks: no
  plaintext `code`/`otp` keys; no ciphertext on SENT/DEAD rows]. BullMQ jobs carry only message ids;
  `lastError` never includes the payload.
- **Login / enumeration:** unknown email, wrong password → `INVALID_CREDENTIALS` with equal timing
  (dummy argon2 verify). `ACCOUNT_SUSPENDED` (and deactivated) only after a correct password. No global
  hard lock: failures are throttled per (email-HMAC, IP) and per IP with exponential backoff in Redis,
  so a third party cannot lock an account for its owner. Password-reset, resend and email-change starts
  always return the same 202; email change to an address that is taken returns the same success and
  notifies that address.
- **Admin MFA:** every user holding a non-MEMBER role must enroll a **TOTP** authenticator (secret
  AES-256-GCM encrypted with `MFA_ENCRYPTION_KEY`, replay protection by last used time-step). First admin
  login with no factor: email OTP bound to that session, then forced TOTP enrollment before any
  `/admin/*` access. `/admin/*` requires `session.mfaMethod = TOTP` verified within the last 12 h.
  Because LOGIN_MFA bootstraps from the mailbox, an admin-role account can **change its email only from a
  TOTP-verified session** (`adminAccess`, checked on start and confirm, else 403 `MFA_REQUIRED`), and a
  LOGIN_MFA code is refused for a session created before the account's email was last changed/verified.
  **TOTP guesses are capped per account** (independent of IP, across verify, enrollment confirm and
  authenticator reset): 10 consecutive wrong codes pause TOTP verification for the account for 15 min
  (doubling with each further failure, max 24 h; a correct code resets the count), revoke the session that
  made them and notify the owner and every SUPER_ADMIN once (audit `auth.mfa.totp_locked`).
  Self-service password reset is disabled for admin-role users. Instead a SUPER_ADMIN (never for
  themselves, reason required) sends an **admin-triggered reset** (`POST /admin/members/:id/password-reset`,
  also usable for plain members): a `PASSWORD_RESET` code to the account's address that records the
  issuing SUPER_ADMIN session (`email_challenges.session_id`); the account's sessions are revoked, the
  owner is told an administrator started it, all SUPER_ADMINs are notified and it is audited
  (`member.password_reset.send`). The password changes only when the owner enters the code on the normal
  reset page. An admin-role account accepts a reset code **only** if it was issued this way and the issuer
  is still an ACTIVE SUPER_ADMIN (a code requested while the account was a member is refused once it
  holds an admin role). Password or email changes (and completed resets) of an admin notify all
  SUPER_ADMINs.
- **Sessions:** opaque 32-byte token in an HttpOnly, SameSite=Lax cookie `sid`; only its SHA-256 is
  stored. Member TTL 7 days, idle 12 h. On MFA success the token is rotated (old row revoked
  `mfa_rotated`) and expiry capped at now + 12 h. Logout revokes; password change/reset, an admin-triggered
  reset, suspension and **any role grant/revoke** revoke all of that user's sessions. LOGIN_MFA codes elevate only the session
  that requested them [DB]. Permissions are loaded per request. Race-safety: creating or elevating a session
  holds the users row `FOR SHARE` and re-checks what was verified (login: the password hash and ACTIVE status;
  elevation: the old session still open, account ACTIVE); revoking all sessions takes the row
  `FOR NO KEY UPDATE` first — so a session can never be created alongside a credential change and survive it.
  A login whose verified hash changed meanwhile fails with `INVALID_CREDENTIALS` and never rehashes over the
  newer password; a password change is likewise conditional on the hash it verified.
- Rate limits (per IP and per account/email): register, login, OTP send/verify, password reset.

## 3. Roles, permissions, segregation of duties

| Role | Capabilities |
|---|---|
| SUPER_ADMIN | Everything: settings, roles, offering approval, auto-approving policies, API clients, referral corrections, audit, flags |
| PROGRAM_ADMIN | **Assigned programs only**: options, policies (draft/publish/preview; only approval-requiring), lifecycle, enrollments, record sales, read members enrolled in those programs and their rewards |
| FINANCE_REVIEWER | Approve/reject/reverse rewards, reverse events, ledger, reconciliation, exports, audit (read) |
| MEMBER | Own profile, enrollments, referral code, own team (privacy-filtered), own rewards |

- Every operation is authorized on the server. Only SUPER_ADMIN assigns roles; nobody grants roles to
  themselves [DB]; at least one ACTIVE SUPER_ADMIN always remains — removal includes suspension and
  deactivation [DB, serialized].
- **Program-scoped reads:** a PROGRAM_ADMIN sees a member only if the member is enrolled in one of their
  programs, and inside a member view only what is in scope: a sponsor outside their programs appears by
  display name only (no full name, email or link), and the member's own PROGRAM_ADMIN assignments are listed
  only for programs within the caller's scope.
- **Segregation of duties [DB]:** nobody approves, rejects or reverses their own reward; the admin who
  recorded a sale can never approve its rewards; an admin cannot record a sale whose subject is
  themselves or anyone in their downline; a reward recipient must be an upline of the sale's subject;
  a member is never rewarded for their own sale; correction performers cannot be the moved member, the
  previous or new sponsor, or an upline of the new sponsor; a flag cannot be resolved by its subject.

## 4. Offerings & programs

- Offering = product/service. New offerings are `INACTIVE`; activation requires `offerings:approve`
  (SUPER_ADMIN) and records the approver [DB]. Only ACTIVE offerings can back a program publication or
  receive sales [DB].
- Program lifecycle [DB state machine]: `DRAFT → SCHEDULED | ACTIVE`, `SCHEDULED → ACTIVE` (scheduler at
  `startsAt`), `ACTIVE ↔ PAUSED` (reason), `ACTIVE | PAUSED → COMPLETED` (manual, sets `endsAt = now`
  if later, or scheduler at `endsAt`), `COMPLETED → ARCHIVED`, and **cancel** `SCHEDULED → ARCHIVED`
  (reason required, only while `startsAt` is still ahead; keeps `endsAt` or sets the earliest end the date
  CHECKs allow, `max(startsAt + 1 s, enrollmentOpensAt + 1 s, enrollmentClosesAt)`) — a scheduled program
  was never ACTIVE, so it has no enrollments or sales. Never back to DRAFT. Only DRAFT programs
  can be deleted. Every status change is recorded in `program_status_changes` [DB trigger; the reason is
  passed with `set_config('app.status_reason', …, true)` and the actor via `updated_by_id`].
- Publish requires: ≥ 1 active option, ACTIVE offering, valid dates, ≥ 1 PUBLISHED policy version.
- After publish: code, offering, unit, currency, max depth frozen [DB]; `startsAt` frozen once started;
  `endsAt` cannot move into the past; dates frozen once COMPLETED [DB]. Name, description, terms (new
  `termsVersion`), enrollment close date may change.
- Dates: `startsAt < endsAt`, `enrollmentOpensAt < enrollmentClosesAt ≤ endsAt` [DB]. Stored UTC,
  displayed in the program time zone. `lateEventGraceDays` (default 30): sales that occurred before
  `endsAt` may still be recorded that many days after it.
- Options: price ≥ 0 in the program currency [DB], duration 1..3660 days and consistent with frequency
  (MONTHLY 28–31, QUARTERLY 89–92, HALF_YEARLY 181–184, YEARLY 365–366, ONE_TIME any). Price, duration
  and frequency of an option that has enrollments never change — create a new option [DB].

## 5. Enrollment

- Preconditions [DB]: member ACTIVE + verified; program ACTIVE with an open enrollment window
  (row-locked against concurrent pause/complete); option active and belonging to the program; plus
  program `eligibility` rules (`minAccountAgeDays`, `requireSponsor`).
- One `PENDING` enrollment per member and program [DB]; activated coverage periods
  `[effectiveFrom, effectiveTo)` never overlap [DB exclusion].
- Stores an immutable `optionSnapshot` (`{optionId, name, priceMinor (string), currencyCode,
  billingFrequency, durationDays, renewalPolicy}`), `termsVersion` and the member's sponsor [DB].
- Payments are collected offline. Free options activate immediately. A paid option is activated by an
  admin (`enrollments:manage`) who records a unique `paymentReference`, `paymentAmountMinor` and time
  [DB: a paid option cannot be ACTIVE without it; payment records are immutable]. Activation sets
  `effectiveFrom = max(now, end of the member's current period)` (renewal without a gap),
  `effectiveTo = effectiveFrom + durationDays`, eligibility `ELIGIBLE`. Admin may reject (`REJECTED`).
- Coverage dates are frozen once set [DB]. Cancellation (member or admin) sets `cancelledAt = now` and
  shortens `effectiveTo` to `max(now, effectiveFrom)` (an unstarted renewal becomes an empty period).
  The scheduler marks `ACTIVE → EXPIRED` once `effectiveTo` has passed. Terminal states never change [DB].

## 6. Referral tree

- One global referral code per member (8 chars from `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, i.e. no 0/O/1/I/L).
  Link `${APP_PUBLIC_URL}/register?ref=CODE`. A code is attribution, never authentication.
- **Attribution happens once, in the transaction that creates the member** (email verification), from
  a code that is active and owned by an ACTIVE, verified sponsor [DB]. Invalid code at registration →
  validation error (the client may continue without a code). At verification the code row and the
  sponsor's users row are locked `FOR SHARE`: a sponsor suspension in flight is waited for and the member
  then joins without a sponsor (`codeNoLongerValid`); a suspension that starts later waits for the
  registration to commit — never a 409.
- **Write protocol [DB-enforced]:** registration takes `pg_advisory_xact_lock_shared(7301, 1)` then
  inserts users row → self closure row (depth 0) → relationship (with `registrationIp`, user agent) →
  ancestor rows (sponsor's rows + 1), with no savepoints. Closure rows must equal the sponsor chain at
  commit [DB]. Relationships are immutable outside corrections [DB].
- **Corrections** (SUPER_ADMIN, `referrals:correct`, reason ≥ 10 chars): take
  `pg_advisory_xact_lock(7301, 1)` first, insert the `referral_corrections` row, then
  `SET LOCAL app.referral_correction_id = '<id>'`, then rewrite the relationship and the closure rows of
  the moved subtree [DB checks cycles, SoD, consistency]. Rejected if the moved subtree has RECEIVED
  (unprocessed) sales. Affects only calculations made afterwards; past rewards never change. The reward
  engine holds the tree lock in **shared** mode while it calculates (§8), so a correction and a sale
  calculation never interleave and the RECEIVED-sales check cannot be overtaken.
- Member visibility: own sponsor + ancestors (display name = first name + last initial, depth, joined
  date); descendants up to depth 10 with display name, depth, joined date, status bucket
  (active / inactive), whether they currently hold an ELIGIBLE enrollment, direct-referral count. Never
  other members' email, phone, prices paid, rewards, sale amounts or eligibility details.

## 7. Reward policies

- Versions per program: `DRAFT → PUBLISHED → RETIRED`; created as DRAFT only [DB]. Published versions
  and their rules are immutable [DB; rule edits lock the version row so they cannot race a publish].
- Effective ranges `[effectiveFrom, effectiveTo)` of non-draft versions never overlap [DB exclusion,
  checked at commit]. `effectiveFrom ≥ now` (no retroactive policies) [DB].
- **Publish at T:** close the version whose range contains T at T; if a published version starts at
  S > T, the new version gets `effectiveTo = S`. One transaction; lock the program's versions first.
- **Retire:** `effectiveTo = max(now, effectiveFrom)` + status RETIRED + `retiredAt`. Retiring a
  version that hasn't started yet withdraws it (empty range). A range can't be closed in the past or
  before sales already bound to it [DB]. Retired versions are frozen [DB].
- Fields: `triggerEventTypes` (≥ 1), `maxDepth` (1..program depth ≤ 10), `budgetBps` (1..5000),
  `maxTotalPerEventMinor?`, `minEventAmountMinor`, `pointsPerCurrencyUnit` (POINTS programs),
  `ineligibleAncestorBehavior` (`FORFEIT` | `COMPRESS`), `roundingMode`, `requiresApproval`,
  `requireActiveEnrollment`.
- `requiresApproval = false` can only be published by a SUPER_ADMIN (`policies:auto-approve`) [DB], and
  even then rewards from ADMIN_MANUAL sales still need manual approval [DB].
- Rules: one per level ≤ maxDepth (gaps allowed). `FIXED` (`fixedAmountMinor`, reward-unit minor units)
  or `PERCENTAGE` (`percentageBps` of the base), optional `capMinor`. Publish validation [DB + app]:
  ≥ 1 rule, levels ≤ maxDepth, Σ percentage bps ≤ budgetBps. The app also warns when fixed levels cannot
  be funded by small sales (compute the break-even sale in sale currency, converting points via the rate).

## 8. Sales intake & reward engine

**Sources & idempotency.** `ADMIN_MANUAL` (recorded by an admin with `events:write` for an assigned
program) or `API`/`WEBHOOK` (an `ApiClient` key scoped to one program; `integrations:manage` creates
keys, shown once, stored as SHA-256). Idempotency key = **(offering, externalId, revision)** [DB], not the
channel: the same sale can't be recorded twice through two channels or into two programs sharing an
offering. `requestHash` = SHA-256 of the canonical request; a replay with the same hash returns the
existing event (only if the caller may see its program), a different hash → 409 `IDEMPOTENCY_CONFLICT`
without echoing the other event. A REJECTED or REVERSED sale may be re-recorded as `revision + 1`
superseding it [DB].

**Intake validation** (the app stores failures as `REJECTED` with a reason when the row itself is valid):
type is a sale type; offering = program offering and ACTIVE [DB]; currency = program currency [DB];
amount > 0; customer reference present; `occurredAt` within the program period, ≤ now + 5 min [DB], the
program was ACTIVE (not PAUSED/SCHEDULED) at `occurredAt` (from `program_status_changes`; changes logged
in one transaction share a timestamp and resolve to the end of their chain, e.g. DRAFT → ACTIVE), and if the
program is COMPLETED, now ≤ `endsAt` + grace; subject member exists and is ACTIVE; recorder SoD [DB];
plan-payment checks (§0.1: any program's payment reference, the subject's own payment amount — refused;
a downline member's — flagged) [DB]; an applicable policy version exists (non-draft, range contains
`occurredAt`, lists the type, amount ≥ minimum) [DB when bound]; for POINTS programs the converted base
(`floor(amount × rate / 10^minorUnits)`) fits a `bigint` (≤ 2^63 − 1), otherwise the sale could never be
stored — the engine re-checks this and rejects instead of failing.

**Stuck sales.** A sale that stays RECEIVED (the sweeper retries every minute) can be rejected by a
reviewer with `events:reverse` (`POST /admin/events/:id/reject`, reason, audited `event.reject`); its
external id can then be re-recorded as `revision + 1`. Serializes with the engine on the event row lock.

**Calculation** (pure, `ENGINE_VERSION` recorded):
1. Base: MONEY → `amountMinor`; POINTS → `floor(amountMinor × pointsPerCurrencyUnit / 10^minorUnits)`.
2. Budget = `floor(base × budgetBps / 10000)`, then `min(budget, maxTotalPerEventMinor)`.
3. Ancestors of the subject by depth (closure table). An ancestor is **eligible** iff user ACTIVE and
   verified, and (if `requireActiveEnrollment`) holds an enrollment in the program with eligibility
   `ELIGIBLE`, `effectiveFrom ≤ occurredAt < effectiveTo`, and status `ACTIVE` or `EXPIRED`, or
   `CANCELLED` with `occurredAt < cancelledAt`. (Determined by `occurredAt`, never by when processing runs.)
   `FORFEIT`: level L ↔ ancestor at depth L; ineligible → level forfeited. `COMPRESS`: k-th eligible
   ancestor (search to depth 50) gets level k.
4. Per level: FIXED amount or `round(base × bps / 10000, roundingMode)`, then `min(·, capMinor)`.
5. Allocate in level order against the remaining budget; zero amounts dropped. Σ ≤ budget always.

**Persistence** (one transaction, idempotent): lock the event `FOR UPDATE`; skip unless RECEIVED; take
`pg_advisory_xact_lock_shared(7301, 1)` (waits for an in-flight sponsor correction, blocks new ones until
commit; ancestors are read under it); bind
the policy to the event [DB re-checks applicability]; insert the calculation (with base, budget,
unit/currency/minor units/points rate snapshot) [DB re-derives the base and checks the cap] and rewards
[DB checks upline, depth, SoD]; mark the event PROCESSED. If the policy doesn't require approval, the
source is not ADMIN_MANUAL **and the sale does not resemble a plan payment** (§0.1, judged with the
event's `created_at` as recording time; the subject is flagged once per sale if it does), rewards are
created `APPROVED` (system) and posted in the same transaction [DB]. Notifications go via the outbox.
Historical rewards are never recalculated.

**Dry-run** (`policies:write`): the same calculator with an admin-supplied sale amount and synthetic
ancestor chain, or a real subject's tree (read-only). No writes. A PROGRAM_ADMIN may preview only a
subject enrolled in the policy's program (otherwise 404), since the result reveals the subject's upline.

## 9. Approval, posting, reversal

- `PENDING_APPROVAL → APPROVED | REJECTED` (reviewer with `rewards:approve`, reason required to reject)
  [DB state machine + SoD]. Approve = approve + post in one transaction.
- Posting [DB-verified shape]: ledger transaction `reward-posting:<rewardId>` with exactly two entries —
  DEBIT `PLATFORM_REWARD_EXPENSE`, CREDIT the recipient's `MEMBER_REWARDS_PAYABLE` — both equal to the
  reward amount, same unit/currency. Accounts are created with `INSERT … ON CONFLICT DO NOTHING`.
  Reward `POSTED` ⇔ exactly one posting [DB].
- Reversal (`rewards:reverse`, reason): `reward-reversal:<rewardId>` mirroring the posting exactly,
  referencing it; reward `REVERSED` ⇔ posting + reversal [DB]. One posting and one reversal per reward
  at most [DB].
- **Event reversal** (refund/chargeback, `events:reverse`, reason): first UPDATE the event to REVERSED
  (row lock), then every reward: `PENDING_APPROVAL/APPROVED → REJECTED`, `POSTED → REVERSED` with a
  compensating transaction — one transaction; the DB rejects a commit that leaves live rewards [DB].
  Approvals lock the event `FOR SHARE`, so approval and reversal serialize [DB]. Partial refunds are not
  supported in v1 (reverse, then re-record a new revision).
- Bulk approve processes each reward in its own transaction and reports per-item results.
- Financial mutations accept an `Idempotency-Key` header persisted in `idempotency_keys`.

## 10. What members see

- Rewards list/detail: `{id, program name, level, amountMinor, rewardUnit, currencyCode, status,
  createdAt (date), decision dates, rejection/reversal reason}`. Never the sale's subject, sale amount,
  exact occurredAt, external id, customer reference or calculation trace (admin-only).
- **Earned to date** (profile + dashboard), per (unit, currency): Σ CREDIT − Σ DEBIT on the member's
  payable accounts (posted minus reversed). **Pending** = Σ PENDING_APPROVAL + APPROVED.
  **Reversed** = Σ REVERSED. Rejected rewards are listed but never totalled as earnings.

## 11. Reconciliation

Exceptions reported (and counted on the admin overview): reward status vs ledger mismatch; posting or
reversal amount ≠ reward amount; unbalanced transaction; member payable balance ≠ Σ posted − Σ reversed
rewards; REVERSED event with live rewards; PROCESSED event whose calculation total ≠ Σ rewards; events
stuck in RECEIVED > 15 min; sales (not rejected or reversed) that resemble a plan payment (§0.1) of the
subject **or of a member of the subject's downline**, in any program with the sale's currency, within
±2 days of the sale date or of its recording (compliance review queue; an item leaves the queue when the
sale is reversed, or when its `PLAN_PAYMENT_LOOKALIKE` flag is resolved or dismissed). Most are
impossible by construction (DB) — the report proves it continuously.

## 12. Fraud signals (advisory)

- Registration enqueues `fraud.registration-attributed`; the worker counts committed attributions for
  (sponsor, registration IP, last 24 h). ≥ 3 → upsert an OPEN `MemberFlag` `SHARED_IP_REGISTRATIONS` with
  dedupe key `SHARED_IP:<sponsorId>:<ip>` [DB unique while OPEN]. A sale resembling a downline member's
  plan payment raises `PLAN_PAYMENT_LOOKALIKE` on its subject (§0.1; one per sale, never re-raised once
  reviewed). Admins (`flags:manage`) can raise
  manual flags and resolve/dismiss them (not their own [DB]). Flags never change balances automatically.

## 13. Audit

- Append-only [DB]. `before`/`after` hold an explicit allow-list of changed fields per action; emails and
  phones masked (`a***@d***.com`); ids instead of names where possible; secret-looking keys are rejected
  [DB CHECK]. `programId` is set on program-scoped entries (programs, options, policies, enrollments,
  events, rewards) so PROGRAM_ADMIN history views can be scoped.
