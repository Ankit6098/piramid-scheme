# API — Reward policies, sales intake & integrations (slice 4)

Business rules: [§7 reward policies](../business-rules.md#7-reward-policies), [§8 sales intake & reward
engine](../business-rules.md#8-sales-intake--reward-engine). Contracts (request schemas + response types):
`packages/shared/src/contracts/policies.ts`, `events.ts`, `integrations.ts`. Conventions (envelopes, cursors,
errors, amounts as decimal strings of minor units, basis points) are in [api.md](../api.md).

All `/admin/*` routes need an admin role, a TOTP-verified session and the listed permission. "Program-scoped"
means the service calls `assertProgramAccess`: SUPER_ADMIN everywhere, PROGRAM_ADMIN only for assigned
programs, FINANCE_REVIEWER read-only on every program (403 `FORBIDDEN` otherwise). Every mutation is audited
inside its transaction with the program id.

Amount units: sale values (`amountMinor` of a sale, `saleAmountMinor`, `minEventAmountMinor`) are in the
program **currency**; reward amounts (`fixedAmountMinor`, `capMinor`, `maxTotalPerEventMinor`, allocations,
rewards) are in the program **reward unit** (currency minor units for MONEY, whole points for POINTS).

## Reward policies

| Method | Path | Permission | Body / query | Response `data` |
|---|---|---|---|---|
| GET | `/admin/programs/:id/policy-context` | programs:read | – | `PolicyContextDto` — program snapshot (unit, currency, minor units, max depth, timezone, status), draft defaults from settings, `hardCapBps` (5000), `pointsLabel`, current / next scheduled version ids |
| GET | `/admin/programs/:id/policies` | programs:read | `cursor`, `limit`, `status` | page of `PolicyVersionSummaryDto`, `version desc` |
| GET | `/admin/policies/:id` | programs:read | – | `PolicyVersionDto` (rules, program, `boundEventCount`) |
| POST | `/admin/programs/:id/policies` | policies:write | `createPolicyDraftSchema` — every field optional, `cloneFromVersionId?` | 201 `PolicyVersionDto` (DRAFT, next version number, name `Policy v<n>` unless given) |
| PATCH | `/admin/policies/:id` | policies:write | `updatePolicyDraftSchema` — partial; `rules` replaces all rules atomically; `expectedUpdatedAt?` | `PolicyVersionDto` |
| DELETE | `/admin/policies/:id` | policies:write | – | `{ id, deleted: true }` |
| POST | `/admin/policies/:id/validate` | policies:write | `{ effectiveFrom?, changes? }` | `{ valid, issues: PolicyIssueDto[] }` |
| POST | `/admin/policies/:id/publish` | policies:publish | `{ effectiveFrom }`; optional `Idempotency-Key` | `{ policy, closedVersion }` |
| POST | `/admin/policies/:id/retire` | policies:publish | `{ reason }` (≥ 10 chars); optional `Idempotency-Key` | `{ policy, withdrawn, warnings[] }` |
| POST | `/admin/policies/:id/dry-run` | policies:write | `{ eventType, saleAmountMinor, ancestors?: [{ eligible }] \| subjectUserId?, occurredAt?, changes? }` | `DryRunResultDto` |
| GET | `/programs/:id/policy` | signed-in user | – | `MemberProgramPolicyDto \| null` |

**Drafts.** Created as DRAFT only. Defaults: budget = `platform_settings.default_reward_budget_bps`, points
rate = `platform_settings.points_per_currency_unit`, `PRODUCT_SALE`, depth `min(3, program max)`, FORFEIT,
HALF_UP, approval required, active enrollment required, no rules. A clone copies every field and rule of any
version of the same program. Row-level shape is validated on save (budget 1..5000 bps, depth 1..10, rule
level 1..10 unique, FIXED needs `fixedAmountMinor > 0`, PERCENTAGE needs `percentageBps` 1..5000 — the field
that does not apply to the type is ignored, caps > 0); cross-field problems (Σ percentages > budget, levels >
depth, depth > program maximum) are reported by validation and block publishing only. A draft's
`effectiveFrom` is `null` until it is published.

**Validation issues** (`severity` `error` blocks publishing, `warning` informs). Codes include
`PROGRAM_CLOSED`, `DEPTH_OUT_OF_RANGE`, `BUDGET_OUT_OF_RANGE`, `NO_TRIGGER_TYPES`, `NO_RULES`,
`LEVEL_OUT_OF_RANGE`, `LEVEL_DUPLICATE`, `PERCENTAGE_OVER_BUDGET`, `RETROACTIVE`, `AUTO_APPROVE_FORBIDDEN`
(error when publishing without `policies:auto-approve`), and the warnings `AUTO_APPROVE`, `CAP_NO_EFFECT`,
`FIXED_OVER_MAX_TOTAL`, `FIXED_BREAK_EVEN` (smallest sale — in the sale currency, converting points through
the policy rate — whose budget funds every fixed level). With `effectiveFrom` the timeline is checked too:
`START_COLLISION` / `RETIRED_OVERLAP` / `BOUND_SALES_AFTER_START` (errors), `CLOSES_CURRENT`, `ENDS_AT_NEXT`,
`STARTS_AFTER_PROGRAM_END` (warnings).

**Publish at T** (one transaction; per-program advisory lock, then every version row of the program
`FOR UPDATE`): T must not be in the past (a start up to 60 s old — "now" from a browser — becomes now). The
version whose range contains T is closed at T; if a version is already scheduled to start at S > T, the new
version gets `effectiveTo = S`, otherwise it is open-ended. Ranges are `[from, to)`.
Errors: 400 `POLICY_INVALID` with `details.issues`; 403 `FORBIDDEN` (`details.missingPermissions =
['policies:auto-approve']`) for `requiresApproval = false` without that permission (the DB enforces it too);
409 `INVALID_STATE_TRANSITION` if the version is not a DRAFT.

**Retire** (`PUBLISHED` only): `effectiveTo = max(now, effectiveFrom)` (never extends a range that already
ended), status RETIRED, `retiredAt = now`. A version that has not started is **withdrawn** (empty range); the
version that was closed when it was scheduled keeps its end, so `warnings` explains the resulting gap. 409
`INVALID_STATE_TRANSITION` for drafts, retired versions, or when sales after the new end are already priced by
the version.

**Immutability.** PATCH/DELETE of a non-draft → 409 `INVALID_STATE_TRANSITION`; rule rows of published
versions are also frozen by a trigger.

**Dry-run** (read-only; drafts included; `changes` previews unsaved edits of a draft). Synthetic mode:
`ancestors[i]` is the ancestor at depth `i + 1` (≤ 50). Member mode: the subject's real upline from the
closure table with the engine's eligibility rules at `occurredAt` (default now) — account ACTIVE + verified
and, if the policy requires it, an ELIGIBLE enrollment covering that instant. The result uses the production
calculator: `applicable` / `notApplicableReason` (type not rewarded, below minimum), `baseMinor`,
`budgetMinor`, `hardCapMinor` (50 % of the base), `totalAllocatedMinor`, `unallocatedMinor`, `allocations`,
per-level `levels[].decision` (`AWARDED`, `NO_RULE`, `NO_ANCESTOR`, `INELIGIBLE_FORFEITED`,
`BUDGET_EXHAUSTED`, `ZERO_AMOUNT`), `ancestors` (display name = first name + last initial in member mode),
`warnings` and the raw `trace`. Exactly one of `ancestors` / `subjectUserId` (400 otherwise); unknown member
→ 404. A program-scoped caller (PROGRAM_ADMIN) may only preview a `subjectUserId` enrolled in the policy's
program (any enrollment status) — anyone else is 404, like the members API.

**Member view.** Programs in SCHEDULED/ACTIVE/PAUSED/COMPLETED (404 otherwise). Returns the version in effect
now, or the next scheduled one (`inEffect: false`), or `null`: levels (type, percentage / fixed amount, cap),
budget bps, the 50 % hard cap, depth, trigger types, minimum sale, max per sale, effective range. No ids,
names, notes, approval settings or authors.

## Sales intake & events

| Method | Path | Permission | Body / query | Response `data` |
|---|---|---|---|---|
| GET | `/admin/events/programs` | programs:read | – | `SaleProgramOptionDto[]` — programs in the caller's read scope, `canRecordSales` (events:write + write access + program ACTIVE/PAUSED/COMPLETED/ARCHIVED) |
| GET | `/admin/events` | rewards:read | `programId`, `status`, `type`, `source`, `from`/`to` (occurredAt), `q` (exact external id or customer reference), `subjectUserId`, `cursor`, `limit` | page of `SaleEventDto`, `createdAt desc, id desc`, scoped to readable programs |
| GET | `/admin/events/:id` | rewards:read | – | `SaleEventDetailDto` — calculation (base, budget, ancestors with eligibility, steps, warnings), rewards, revisions, `compliance` (plan-payment review, below) |
| POST | `/admin/events` | events:write | `recordSaleSchema`; optional `Idempotency-Key` | 201 new / 200 replay: `{ event: SaleEventDetailDto, outcome, replayed }` |
| POST | `/admin/events/:id/reject` | events:reverse (scoped) | `{ reason }` (10–480 chars); `Idempotency-Key` required | `SaleEventDetailDto` — the sale is now `REJECTED` (`rejectionReason` = "Rejected by an administrator: <reason>"); 409 `INVALID_STATE_TRANSITION` unless it is RECEIVED |

`POST /admin/events/:id/reverse` (events:reverse) is documented in [finance.md](finance.md).

The web "Record sale" sheet picks the credited member with a search over `GET /admin/members?q=&status=ACTIVE&limit=8`
(members:read; name or email, or a pasted member id) and never offers the recorder themselves (recorder SoD).

**Request.** `{ programId, type (PRODUCT_SALE | SERVICE_COMPLETED | SUBSCRIPTION_RENEWAL), externalId,
customerReference, subjectUserId, amountMinor (> 0, program currency), currencyCode?, occurredAt,
description?, supersedesEventId? }`.

**Idempotency.** Key = (offering, externalId, revision) — not the channel. `requestHash` = SHA-256 of the
canonical facts `{ programId, type, externalId, customerReference, subjectUserId, amountMinor, currencyCode,
occurredAt (ms ISO), supersedesEventId }` (the description is not a fact). For an external id already known:
- a revision with the same hash → **replay** (200, `replayed: true`) if the caller may see its program
  (admin read scope / the API client's program), else 409;
- different facts while the latest revision is RECEIVED/PROCESSED → 409 `IDEMPOTENCY_CONFLICT` (nothing about
  the other event is echoed; the same sale in another program sharing the offering is refused the same way);
- latest revision REJECTED/REVERSED → stored as `revision + 1` superseding it. Passing `supersedesEventId`
  makes the re-record explicit (allows re-submitting identical facts); it must be the latest revision (409
  `CONFLICT`, `details.reason = 'STALE_SUPERSEDE'`), which must be REJECTED/REVERSED (409
  `INVALID_STATE_TRANSITION`); for an unknown sale → 400.
Concurrent identical requests produce one event (the losers replay it). The `Idempotency-Key` header adds the
generic per-actor replay on top.

**Errors that store nothing.** 400 `VALIDATION_FAILED` (schema; `currencyCode` ≠ program currency; unknown
`subjectUserId`), 403 (no write access to the program / missing events:write), 404 unknown program, 409
`CONFLICT` with `details.reason = 'RECORDER_SOD'` when an admin records a sale credited to themselves or a
member of their own downline.

**Stored as REJECTED** (201, `outcome: REJECTED`, `event.rejectionReason`): sale dated > 5 min in the future;
outside the program period; offering not ACTIVE; external id is an enrollment payment reference **of any
program**, or the subject has a plan payment of the same amount in **any program with the sale's currency**
recorded within ±2 days of `occurredAt` **or of now** (plan payments never earn rewards; back-dating does not
help); program not ACTIVE at `occurredAt` (from `program_status_changes`); program COMPLETED/ARCHIVED and the late
window (`endsAt + lateEventGraceDays`) has closed; subject not ACTIVE + verified; no non-draft policy covering
`occurredAt`; policy does not list the type; amount below the policy minimum; POINTS program whose converted
base (`amount × pointsPerCurrencyUnit / 10^minorUnits`) exceeds 2^63 − 1 ("The sale amount is too large…").

**Plan-payment lookalikes (compliance review).** A sale with the amount of a plan payment by a member of the
subject's **downline** (any depth; same currency; recorded within ±2 days of `occurredAt` or of the recording)
is accepted, but flagged: its rewards are always created `PENDING_APPROVAL` — also for API sales under a
policy with `requiresApproval = false` (the DB refuses an auto-approved reward for it) — and an OPEN
`PLAN_PAYMENT_LOOKALIKE` member flag (dedupe key `PLAN_PAYMENT_LOOKALIKE:<eventId>`, once per sale) is raised on
the subject. `SaleEventDetailDto.compliance` = `{ planPaymentLookalike, message, matches: [{ relation: OWN |
DOWNLINE, depth, enrollmentId, program, payer, amountMinor, currencyCode, paymentRecordedAt }], flag: { id,
status } | null }` (re-evaluated on every read with the sale's `createdAt` as recording time; `planPaymentLookalike`
is also true when a flag was raised at processing). The admin reward row/detail carry the same signal
(`event.planPaymentLookalike`, `compliance`), see [finance.md](finance.md).

**Stuck sales.** `POST /admin/events/:id/reject` (events:reverse) rejects a sale that is still RECEIVED (e.g. one
the engine can never process), so its external id can be re-recorded as a new revision. It locks the event row
(serializing with the engine), audits `event.reject` with the reason, and returns the updated detail.

**Processing.** A valid sale is stored RECEIVED and, after commit, `RewardEngineService.processEvent` runs
(binds the policy, stores the calculation + rewards, PROCESSED; a POINTS base that cannot be stored is
rejected instead). The response reflects the stored state:
`outcome` ∈ `REWARDS_CREATED`, `NO_ELIGIBLE_RECIPIENTS`, `REJECTED`, `PENDING` (engine failed — the event stays
RECEIVED), `REVERSED`. The scheduled job **`events-received-sweeper`** (every minute) re-runs the engine for
events RECEIVED for more than 2 minutes (batch of 100, idempotent).

**Engine transaction & the referral tree.** `processEvent` locks the event row `FOR UPDATE` (concurrent runs
serialize; one calculation per event), skips it unless RECEIVED, then takes the referral tree lock in **shared**
mode (`pg_advisory_xact_lock_shared(7301, 1)`, `lockReferralTreeShared`) until commit. A sponsor correction holds
the same lock **exclusively**, so the two never interleave: a sale processed while a correction is in flight
waits and is calculated on the corrected tree, and a correction waits for in-flight calculations — its "no
RECEIVED sales in the moved subtree" check therefore cannot be overtaken by a sale processed on the old tree.
Sales and registrations (also shared) still run in parallel. Lock order is event row → tree lock; corrections
never lock event rows, so the order cannot deadlock.

## Integrations

| Method | Path | Permission | Body / query | Response `data` |
|---|---|---|---|---|
| GET | `/admin/integrations/clients` | integrations:manage | `programId`, `status` (ACTIVE / REVOKED), `cursor`, `limit` | page of `ApiClientDto` |
| POST | `/admin/integrations/clients` | integrations:manage | `{ programId, name }` | 201 `{ client: ApiClientDto, apiKey }` — the only time the key is returned |
| POST | `/admin/integrations/clients/:id/revoke` | integrations:manage | `{ reason? }` | `ApiClientDto`; 409 `INVALID_STATE_TRANSITION` if already revoked |
| POST | `/integrations/events` | API key | `ingestSaleSchema` (= the admin body; `programId` optional) | 201 / 200 `IntegrationSaleResultDto` |

Keys look like `rpk_<43 base64url chars>`; only `SHA-256(key)` and the first 12 characters (`keyPrefix`) are
stored. Clients cannot be created for ARCHIVED programs.

**Machine ingestion.** `Authorization: Bearer <key>`; no cookie session and no CSRF (`@Public`, `@SkipCsrf`);
rate-limited to 120 requests/min per IP. The key is checked before the body: missing, unknown or revoked → 401
`UNAUTHENTICATED`. A `programId` other than the key's program → 403. Then the same intake as the admin route
(source `API`, `api_client_id` set, audited with `actorRoles = ['API_CLIENT']`), and `lastUsedAt` is updated.
Under a policy with `requiresApproval = false`, rewards from API sales are approved and posted immediately —
except for a sale that resembles a plan payment (above), whose rewards wait for a reviewer.
The response is deliberately minimal: `{ id, programId, externalId, revision, type, amountMinor,
currencyCode, occurredAt, status, outcome, rejectionReason, createdAt, replayed }` — no member or reward
details.

```http
POST /api/v1/integrations/events
Authorization: Bearer rpk_…
Content-Type: application/json

{ "type": "PRODUCT_SALE", "externalId": "INV-2026-0042", "customerReference": "cust_981",
  "subjectUserId": "6f1c…", "amountMinor": "149900", "occurredAt": "2026-10-10T08:15:00Z" }
```
