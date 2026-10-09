# Business Rules

Authoritative domain rules. Code, tests and UI copy must agree with this document. When a rule
changes, update this file in the same change.

## 0. Compliance guardrails (fixed, not configurable)

1. **Rewards are funded only by qualifying sales of an approved Offering** (product or service).
   Valid trigger types: `PRODUCT_SALE`, `SERVICE_COMPLETED`, `SUBSCRIPTION_RENEWAL`.
   Registration, referral, and program enrollment are **never** reward triggers.
2. **Budget cap.** Total rewards for one event ≤ `budgetBps` of the sale amount, and `budgetBps ≤ 5000`
   (50%) — enforced by a DB CHECK, the policy validator and the engine.
3. **No guaranteed returns.** UI never shows projected/guaranteed income. Program options are plans for
   the offering, not investments; their price is not a deposit and earns nothing.
4. **No payouts.** The ledger records reward liabilities. Payout execution is not implemented;
   `payoutsEnabled` must remain false until legal/KYC/provider approvals exist (future module).

## 1. Platform settings

- Singleton row. `rewardUnit`: `MONEY` (rewards are currency amounts) or `POINTS` (non-cash points).
- `currencyCode` (ISO 4217) + `currencyMinorUnits` — used for option prices and sale amounts, and for
  rewards in MONEY mode. `pointsLabel` (e.g. "Points") and `pointsPerCurrencyUnit` (points earned per
  1 major unit of sale value, used for percentage rules in POINTS mode).
- Only SUPER_ADMIN (`settings:write`) can change settings; changes are audited with a reason.
- A **program snapshots** `rewardUnit` + `currencyCode` at creation. Published programs never change
  unit/currency (DB trigger). Changing the platform setting therefore affects new programs and global
  display defaults; historic rewards/ledger keep their own stored unit+currency and are shown with it.
- Changing `currencyCode` is blocked while any non-DRAFT program uses a different currency
  (prevents mixing currencies across live programs). Changing `rewardUnit` is allowed; it affects new programs.
- All amount rendering goes through `formatAmount(amountMinor, { unit, currencyCode, minorUnits, pointsLabel })`.

## 2. Accounts & authentication

- Email is normalized (trim + lower-case) and unique. Status: `PENDING_VERIFICATION → ACTIVE`;
  `ACTIVE ↔ SUSPENDED` (admin, reason required); `DEACTIVATED` (terminal, member-initiated or admin).
- Password: ≥ 10 chars, at least one letter and one digit; hashed with argon2id.
- **OTP**: 6 digits from a CSPRNG; stored as HMAC-SHA-256(pepper, `purpose:email:code`); TTL 10 min;
  max 5 verification attempts; single use; issuing a new code invalidates older open codes of the same
  purpose+email; resend cooldown 60 s; max 5 sends per email+purpose per hour.
- **Registration** returns the same generic response whether or not the email exists (no account
  enumeration). For an existing address, a "someone tried to register" notice is emailed instead.
- **Login**: generic "invalid email or password". 5 consecutive failures lock the account for 15 min.
  Unverified accounts receive `EMAIL_NOT_VERIFIED` only after a correct password.
- **Admin MFA**: any user holding a non-MEMBER role gets a session with `mfaVerified=false` and an
  emailed `LOGIN_MFA` code; `/admin/*` endpoints require `mfaVerified=true`.
- **Sessions**: opaque 32-byte token in an HttpOnly, SameSite=Lax cookie (`sid`); only its SHA-256 is
  stored. Absolute TTL 7 days (admins 12 h); idle timeout 12 h; logout revokes; password change/reset
  revokes all sessions; suspension revokes all sessions.
- **Password reset** and **email change** use OTP challenges; email change requires the current password
  and verification of the new address; the old address is notified.
- Rate limits (per IP and per account/email): register, login, OTP send, OTP verify, password reset.

## 3. Roles & permissions

| Role | Capabilities |
|---|---|
| SUPER_ADMIN | Everything, incl. settings, role assignment, referral corrections |
| PROGRAM_ADMIN | Manage **assigned** programs: options, policies (draft/publish/preview), lifecycle, record qualifying events, view members & rewards for those programs |
| FINANCE_REVIEWER | Approve/reject rewards, reverse rewards/events, ledger, reconciliation, exports. Cannot edit programs or policies |
| MEMBER | Own profile, enrollments, referral code, own team (privacy-filtered), own rewards |

- Permissions are checked on the server for every operation. A user cannot grant roles to themselves;
  only SUPER_ADMIN assigns roles; the last SUPER_ADMIN cannot be removed.
- Segregation of duties: a reviewer cannot approve/reject a reward where they are the recipient.

## 4. Offerings & programs

- Offering = approved product/service (`ACTIVE`/`INACTIVE`). Only ACTIVE offerings can be attached to
  new programs or receive new events.
- Program lifecycle:
  - `DRAFT` — fully editable; deletable.
  - publish → `SCHEDULED` (if `startsAt` > now) or `ACTIVE`. Requires ≥ 1 active option, an ACTIVE
    offering, valid dates, and ≥ 1 non-draft policy version (or one published in the same action).
  - `SCHEDULED → ACTIVE` automatically at `startsAt` (scheduler).
  - `ACTIVE ↔ PAUSED` (manual, reason). While paused: no enrollments; events are rejected.
  - `ACTIVE/PAUSED → COMPLETED` manually or automatically at `endsAt`. `COMPLETED → ARCHIVED`.
  - Never back to `DRAFT`. Non-draft programs cannot be deleted.
- After publish, editable: name, description, terms (new `termsVersion`), `endsAt`/`enrollmentClosesAt`
  (not into the past), options (add, deactivate, edit wording — price/duration edits create a new option).
  Unit, currency and offering are frozen.
- Dates: `startsAt < endsAt`; `enrollmentOpensAt < enrollmentClosesAt ≤ endsAt`. Stored UTC; displayed in
  the program `timezone`.
- Options: `priceMinor ≥ 0` (program currency), `billingFrequency`, `durationDays` 1..3660,
  `renewalPolicy`. Duration should match frequency (MONTHLY≈28–31, QUARTERLY≈89–92, HALF_YEARLY≈181–184,
  YEARLY≈365–366, ONE_TIME any) — validator enforces these ranges.

## 5. Enrollment

- Preconditions: member `ACTIVE` + email verified; program `ACTIVE`; now within the enrollment window;
  option active; program `eligibility` satisfied (`minAccountAgeDays`, `requireSponsor`).
- At most one open (`PENDING`/`ACTIVE`) enrollment per member per program (partial unique index).
- Stores an immutable `optionSnapshot`, `termsVersion`, and the member's sponsor at that time.
- Payment collection is not implemented: free options (price 0) activate immediately; paid options start
  `PENDING` until an admin records the offline payment and **activates** (`effectiveFrom = now`,
  `effectiveTo = now + durationDays`, `eligibilityStatus = ELIGIBLE`). Admin may reject (`REJECTED`).
- Member may cancel (`CANCELLED`). Scheduler expires `ACTIVE` enrollments after `effectiveTo` (`EXPIRED`).
  Terminal statuses never change (DB trigger). Renewal = new enrollment.

## 6. Referral tree

- Each member has one global referral code (8 chars, Crockford-style alphabet without 0/O/1/I/L, upper
  case). Link: `${APP_PUBLIC_URL}/register?ref=CODE`. A code is attribution, never authentication.
- Attribution happens **only at registration**, server-side, from a valid code whose owner is ACTIVE and
  verified. Invalid code → validation error (the client may retry without a code). Self-referral and
  cycles are impossible by construction (a new user has no descendants) and by DB checks.
- `referral_relationships`: exactly one row per child (unique), immutable (trigger).
  `referral_paths`: closure rows for every ancestor/descendant pair including depth 0 self rows; written
  in the same transaction as the user.
- **Corrections** (SUPER_ADMIN, `referrals:correct`): move a member (with their subtree) under a new
  sponsor. Reason ≥ 10 chars. Rejected if the new sponsor is the member or inside the member's subtree.
  Rewrites closure rows inside one transaction with `SET LOCAL app.referral_correction = 'on'`,
  writes `referral_corrections` + audit. Affects only future reward calculations.
- Member visibility: own sponsor + ancestors (display name = first name + last initial, depth, joined
  date); descendants up to depth 10 with display name, depth, joined date, status bucket
  (active / inactive / pending), whether they hold an active enrollment, and direct-referral count.
  Never other members' email, phone, enrollment prices, rewards or sale amounts.

## 7. Reward policies

- Versions per program: `DRAFT → PUBLISHED → RETIRED`. Published versions are immutable (DB trigger);
  to change rules create a new version.
- Effective ranges `[effectiveFrom, effectiveTo)` of non-draft versions never overlap (exclusion
  constraint). Publishing a version with `effectiveFrom = T` closes the currently open version at `T`.
  `effectiveFrom` must be ≥ now (no retroactive policies). Retire = close range at now + status RETIRED.
- Fields: `triggerEventTypes` (≥ 1), `maxDepth` (1..program.maxRewardDepth ≤ 10), `budgetBps` (1..5000),
  optional `maxTotalPerEventMinor`, `minEventAmountMinor`, `ineligibleAncestorBehavior`
  (`FORFEIT` | `COMPRESS`), `roundingMode` (`HALF_UP` | `HALF_EVEN` | `DOWN`), `requiresApproval`,
  `requireActiveEnrollment`.
- Rules: one per level 1..maxDepth (gaps allowed = no reward at that level). `FIXED` (`fixedAmountMinor`
  in reward-unit minor units) or `PERCENTAGE` (`percentageBps` of the base), optional `capMinor`.
- Publish validation: ≥ 1 rule; every rule level ≤ maxDepth; Σ percentage bps ≤ budgetBps; program not
  COMPLETED/ARCHIVED. The dry-run reports warnings when fixed amounts would exceed the budget for a
  given sale amount.

## 8. Reward engine (pure calculation + transactional processing)

**Event intake** (`events:write`): admin/API records a qualifying event with `externalId` (unique per
source → idempotent: a repeat returns the existing event). Validation → otherwise `REJECTED` with reason:
event type allowed by schema; program `ACTIVE`; offering = program offering and ACTIVE; currency =
program currency; `amountMinor > 0`; `occurredAt` within program dates and not > now + 5 min; subject
member exists and is `ACTIVE`; an applicable policy version exists (non-draft, range contains
`occurredAt`) and lists the event type; amount ≥ `minEventAmountMinor`.

**Calculation** (pure function, engine version string recorded):
1. **Base** (reward-unit minor units): MONEY → `amountMinor`. POINTS →
   `round_down(amountMinor × pointsPerCurrencyUnit / 10^currencyMinorUnits)`.
2. **Budget** = `round_down(base × budgetBps / 10000)`, then `min(budget, maxTotalPerEventMinor)` if set.
3. **Recipients** — ancestors of the subject ordered by depth (closure table):
   - An ancestor is *eligible* iff user `ACTIVE`, email verified, and (if `requireActiveEnrollment`) holds an
     enrollment in the program with status `ACTIVE`, eligibility `ELIGIBLE`, and
     `effectiveFrom ≤ occurredAt < effectiveTo`.
   - `FORFEIT`: level L ↔ ancestor at depth L. Missing → stop; ineligible → level forfeited (traced).
   - `COMPRESS`: the k-th *eligible* ancestor (searching up to depth 50) receives level k.
4. **Amount per level**: FIXED → `fixedAmountMinor`; PERCENTAGE → `round(base × bps / 10000, roundingMode)`;
   then `min(amount, capMinor)`.
5. **Budget allocation** in level order: `amount = min(amount, remainingBudget)`; zero amounts are dropped
   (traced as "budget exhausted").
6. Output: rewards (level, recipient, amount) + full trace (inputs, every ancestor considered, decisions,
   rounding, caps, budget before/after). Σ amounts ≤ budget always.

**Persistence** (one DB transaction, idempotent): lock the event row (`FOR UPDATE`), skip if already
processed; insert `reward_calculations` (unique per event) and `rewards` (unique per event+level and
event+recipient); mark event `PROCESSED`. If `requiresApproval = false` rewards are created
`APPROVED` (system) and posted to the ledger in the same transaction. Notifications go via the outbox.
Historical rewards are never recalculated when policies change.

**Dry-run** (`policies:write`): runs the same pure calculator against a draft or published version with
an admin-supplied sale amount and a synthetic ancestor chain (eligibility per level). No writes.

## 9. Approval, posting, reversal

- `PENDING_APPROVAL → APPROVED | REJECTED` (reviewer, reason required for reject).
- `APPROVED → POSTED`: ledger transaction (idempotency key `reward-posting:<rewardId>`): DEBIT
  `PLATFORM_REWARD_EXPENSE`, CREDIT the recipient's `MEMBER_REWARDS_PAYABLE` (accounts created on demand
  per unit+currency). Approval posts immediately (approve = approve + post, one transaction).
- `POSTED → REVERSED` (`rewards:reverse`, reason): compensating transaction
  (`reward-reversal:<rewardId>`, references the original) with mirrored entries.
- **Event reversal** (refund/chargeback, `events:reverse`): event `PROCESSED → REVERSED`; every reward of the
  event: `PENDING_APPROVAL/APPROVED → REJECTED` ("event reversed"), `POSTED → REVERSED` with compensating
  entries — all in one transaction. Partial refunds are not supported in v1 (reverse and re-record).
- Bulk approve processes each reward in its own transaction and reports per-item results.
- Ledger rows are never updated or deleted (triggers); every transaction balances (deferred trigger).

## 10. Earnings shown to members

Per (unit, currency) bucket:
- **Earned to date** = Σ CREDIT − Σ DEBIT on the member's `MEMBER_REWARDS_PAYABLE` accounts (posted minus reversed).
- **Pending** = Σ rewards in `PENDING_APPROVAL` + `APPROVED`.
- **Reversed** = Σ rewards in `REVERSED`. Rejected rewards are listed but not totalled as earnings.

## 11. Reconciliation

For each reward: `POSTED` ⇒ exactly one posting txn whose member credit equals `amountMinor`;
`REVERSED` ⇒ posting + reversal txns; `PENDING/APPROVED/REJECTED` ⇒ no posting txn. Also: every ledger
transaction balances; member account balance = Σ posted − Σ reversed rewards. Mismatches are reported
as exceptions on the reconciliation page and counted on the admin overview.

## 12. Fraud signals (v1, advisory)

- ≥ 3 registrations attributed to the same sponsor from the same IP within 24 h → `MemberFlag`
  `SHARED_IP_REGISTRATIONS` on the sponsor. Admins can raise manual flags and resolve/dismiss them.
  Flags never change balances automatically.
