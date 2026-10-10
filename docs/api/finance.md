# API — Rewards, approvals, ledger & reconciliation (slice 5, finance)

Business rules: [§9 approval, posting, reversal](../business-rules.md#9-approval-posting-reversal),
[§10 what members see](../business-rules.md#10-what-members-see), [§11 reconciliation](../business-rules.md#11-reconciliation).
Contracts (request schemas + response types): `packages/shared/src/contracts/rewards.ts` and `ledger.ts`
(ledger + reconciliation). Conventions (envelopes, cursors, error shape, amounts as decimal strings of
integer minor units) are in [api.md](../api.md).

All `/admin/*` routes need an admin role, a TOTP-verified session (12 h) and the listed permission(s) —
all listed permissions are required. **Program-scoped** = `assertProgramAccess(auth, programId, 'read')`:
SUPER_ADMIN and FINANCE_REVIEWER see every program, PROGRAM_ADMIN only assigned programs (lists are
filtered; a detail or an explicit `programId` filter outside the scope → 403 `FORBIDDEN`). Ledger accounts,
ledger totals and the reconciliation report span every program and require global read (SUPER_ADMIN /
FINANCE_REVIEWER), otherwise 403.

Every amount travels with its own `rewardUnit`, `currencyCode` and `currencyMinorUnits` (POINTS amounts are
formatted with 0 minor units). Sale amounts (`event.amountMinor`) are always in the program currency.

Date filters `from` / `to` accept an ISO date-time with offset or a calendar date `YYYY-MM-DD` (UTC day).
`from` is inclusive, `to` exclusive (a calendar-date `to` includes that whole day). The web sends local-day
boundaries as ISO date-times.

## Admin: rewards queue

| Method | Path | Permission | Query / body | Response `data` |
|---|---|---|---|---|
| GET | `/admin/rewards` | rewards:read (scoped) | `cursor`, `limit` (≤ 100), `status`, `programId`, `recipientUserId`, `eventId`, `level` (1–10), `from`, `to` (created), `q` (recipient name/email contains), `order` `asc`\|`desc` (default `desc`) | page of `AdminRewardRowDto` |
| GET | `/admin/rewards/counts` | rewards:read (scoped) | same filters without `status`/cursor | `AdminRewardCountsDto` `{ byStatus: Record<RewardStatus, number>, total }` |
| GET | `/admin/rewards/facets` | rewards:read (scoped) | – | `{ programs: FinanceProgramRef[] }` (programs with rewards) |
| GET | `/admin/rewards/:id` | rewards:read (scoped) | – | `AdminRewardDetailDto` |
| GET | `/admin/rewards/export.csv` | reports:export + rewards:read (scoped) | list filters + `order` | `text/csv` stream (see CSV) |

`AdminRewardRowDto`: id, status, level, `amountMinor` + unit/currency/minor units, `program` (id, name,
code, timezone), `recipient` (id, fullName), `event` (id, externalId, revision, type, source, status,
`amountMinor`, currencyCode, occurredAt, `subject`, `recordedBy`), createdAt, decision fields
(`approvedAt/By`, `postedAt`, `rejectedAt/By`, `rejectionReason`, `reversedAt/By`, `reversalReason`) and
`viewer: { isRecipient, recordedSale }` — segregation-of-duties hints for the caller (the server enforces
them regardless).

**Web deep links** (`/admin/rewards`): `?tab=` (or its alias `?status=`, used by the admin overview) selects the
status tab (`PENDING_APPROVAL` default, `POSTED`, `REJECTED`, `REVERSED`, `ALL`); `?recipientUserId=<uuid>`
(member detail "View rewards") and `?event=<uuid>` (one sale) scope the list, counts and CSV export via the
`recipientUserId` / `eventId` filters and open on the `ALL` tab unless a tab is given; `?reward=<id>` opens the
detail drawer (ledger and reconciliation link with `?tab=ALL&reward=`). Malformed ids are ignored.
`/admin/enrollments` keeps its status filter in `?status=` (`PENDING` default, any `EnrollmentStatus`, `ALL`).

`AdminRewardDetailDto` adds: `event.customerReference/description/processedAt/reversedAt/reversalReason`,
`policyVersion` (id, version, name, requiresApproval), `calculation` (snapshot: base, budget bps/amount,
total allocated, points rate, engine version, outcome) with a readable **trace** (`levels[]`: level,
decision `AWARDED | NO_RULE | NO_ANCESTOR | INELIGIBLE_FORFEITED | BUDGET_EXHAUSTED | ZERO_AMOUNT`, member,
depth, rule type / bps / fixed amount / cap, rule amount, final amount, `capped`, `budgetLimited`, remaining
budget, reason, `isThisReward`; `ancestors[]` with eligibility at the sale date; `warnings[]`; `raw` JSON;
`parsed = false` for unrecognised traces), `siblings` (other rewards of the sale), `ledgerTransactions`
(with entries) and `auditTrail` (reward + sale audit entries, oldest first, ≤ 100).

## Admin: decisions

All decisions require an **`Idempotency-Key`** header (8–128 chars; missing → 400). The same key + same
request replays the stored response (`Idempotent-Replayed: true`); the same key with a different request →
409 `IDEMPOTENCY_CONFLICT`; while the first request runs → 409 `CONFLICT` (`details.retryable`).

| Method | Path | Permission | Body | Response `data` |
|---|---|---|---|---|
| POST | `/admin/rewards/:id/approve` | rewards:approve (scoped) | – | `RewardDecisionResultDto` `{ id, status: 'POSTED', ledgerTransaction: { id, type: 'REWARD_POSTING' } }` |
| POST | `/admin/rewards/:id/reject` | rewards:approve (scoped) | `{ reason }` (10–480 chars) | `{ id, status: 'REJECTED', ledgerTransaction: null }` |
| POST | `/admin/rewards/:id/reverse` | rewards:reverse (scoped) | `{ reason }` (10–480 chars) | `{ id, status: 'REVERSED', ledgerTransaction: { id, type: 'REWARD_REVERSAL' } }` |
| POST | `/admin/rewards/bulk-approve` | rewards:approve | `{ ids: uuid[] }` (1–100, unique) | `BulkApproveResultDto` `{ results: [{ id, ok: true, status, ledgerTransactionId } \| { id, ok: false, error: { code, message } }], approved, failed }` |
| POST | `/admin/events/:id/reverse` | events:reverse (scoped) | `{ reason }` (10–480 chars) | `EventReversalResultDto` `{ eventId, status: 'REVERSED', reversedAt, rejectedRewardIds, reversedRewardIds }` |

**Approve** = approve + post in **one transaction**: lock the sale `FOR SHARE`, lock the reward `FOR
UPDATE`, re-check status and segregation of duties, `PENDING_APPROVAL → APPROVED` (approvedBy = caller),
then `LedgerService.postReward` writes `reward-posting:<rewardId>` (DEBIT platform reward expense / CREDIT
the recipient's rewards payable, both = reward amount) and moves the reward to `POSTED`. Audit
`reward.approve` and the member notification (`reward.posted`) are written in the same transaction.
Concurrent approvals of one reward produce exactly one posting: the others get 409.

**Reject** (`PENDING_APPROVAL`/`APPROVED` only): `REJECTED` with `rejectedBy` and the reason; no ledger
write; audit `reward.reject`; notification `reward.rejected` (the member sees the reason).

**Reverse** (`POSTED` only): `LedgerService.reverseReward` writes `reward-reversal:<rewardId>` mirroring the
posting and sets `REVERSED` (reversedBy, reason); audit `reward.reverse`; notification `reward.reversed`.

**Bulk approve** runs one approve per id, each in its own transaction, sequentially; failures never stop
the batch and are reported per item with the same codes as the single endpoint (`NOT_FOUND`,
`INVALID_STATE_TRANSITION`, `CONFLICT` for SoD, `FORBIDDEN` for program scope).

**Event reversal** (refund / chargeback; `PROCESSED` sales only), one transaction: `UPDATE` the sale to
`REVERSED` first (row lock — approvals hold the sale `FOR SHARE`, so an approval either commits first and its
reward is then reversed, or waits and fails with 409), then every reward of the sale: `PENDING_APPROVAL` /
`APPROVED` → `REJECTED` (reason `"Sale reversed: <reason>"`, rejectedBy = caller), `POSTED` → `REVERSED` with
a compensating ledger transaction. Audits `event.reverse` plus one `reward.reject` / `reward.reverse` per
reward; each affected member is notified. The DB refuses a commit that leaves live rewards. In the web app,
a reversal from the sales events page (like one from the rewards queue) refreshes the sales, the approval queue
and its counts, the ledger, reconciliation and the admin overview counters.

Errors (all decisions):

| Status / code | When |
|---|---|
| 400 `VALIDATION_FAILED` | bad id, reason < 10 or > 480 chars, missing `Idempotency-Key`, bulk list empty / > 100 / duplicates |
| 403 `FORBIDDEN` | missing permission (`details.missingPermissions`) or program outside the caller's scope |
| 404 `NOT_FOUND` | unknown reward / sale |
| 409 `CONFLICT`, `details: { reason: 'SEGREGATION_OF_DUTIES', rule: 'OWN_REWARD' \| 'RECORDED_SALE' }` | checked **before** the DB: nobody decides on a reward credited to them; the admin who recorded a sale cannot approve its rewards; a recipient of any live reward of a sale cannot reverse that sale ("another reviewer must…") |
| 409 `INVALID_STATE_TRANSITION` (`details.status`) | already posted / rejected / reversed; reverse of a non-posted reward; approval after the sale was reversed; event not `PROCESSED` (`RECEIVED`, `REJECTED`, already `REVERSED`) |
| 409 `INVARIANT_VIOLATION` | a DB trigger refused the change (should not happen; report it) |

## Admin: ledger

| Method | Path | Permission | Query | Response `data` |
|---|---|---|---|---|
| GET | `/admin/ledger/summary` | ledger:read (global) | – | `LedgerSummaryDto` `{ transactionCount, buckets: [{ unit…, postedMinor, postedCount, reversedMinor, reversedCount, outstandingLiabilityMinor, expenseMinor, memberAccounts }] }` |
| GET | `/admin/ledger/transactions` | ledger:read (scoped via the reward's program) | `cursor`, `limit`, `type`, `from`, `to` (posted), `memberId` (reward recipient), `rewardId`, `programId` | page of `LedgerTransactionDto` (`postedAt desc`) |
| GET | `/admin/ledger/transactions/:id` | ledger:read (scoped) | – | `LedgerTransactionDetailDto` (+ `entries[]`: account id/type/owner, direction, amount) |
| GET | `/admin/ledger/accounts` | ledger:read (global) | `cursor`, `limit`, `type`, `memberId`, `rewardUnit`, `currencyCode`, `nonZero=true` | page of `LedgerAccountDto` (from the `ledger_account_balances` view; `balanceMinor` = credits − debits for member payables, debits − credits for platform expense) |
| GET | `/admin/ledger/export.csv` | reports:export + ledger:read | transaction filters + `order` | `text/csv`, one row per ledger entry |

`LedgerTransactionDto`: id, type, idempotencyKey, `amountMinor` (= debit total = reward amount) +
unit/currency/minor units, entryCount, description (the reason for reversals), postedAt, postedBy (null =
system auto-approval), `reward` (id, level, status, eventId), `member`, `program`, `reversesTransactionId`,
`reversedByTransactionId`. The ledger records liabilities only; there are no payouts.

## Admin: reconciliation

| Method | Path | Permission | Query | Response `data` |
|---|---|---|---|---|
| GET | `/admin/reconciliation` | reconciliation:read (global) | `refresh=true` bypasses the cache | `ReconciliationReportDto` |

The report runs eight SQL checks (business rules §11) and is cached for ~60 s per API process:

| Key | Severity | Detects |
|---|---|---|
| `REWARD_LEDGER_STATUS_MISMATCH` | critical | POSTED without exactly one posting, REVERSED without posting + reversal, other statuses with ledger rows |
| `LEDGER_AMOUNT_MISMATCH` | critical | posting/reversal header or entries ≠ reward amount / unit / currency |
| `UNBALANCED_TRANSACTION` | critical | debits ≠ credits (also per unit/currency), entry count or header total mismatch |
| `PAYABLE_BALANCE_MISMATCH` | critical | member payable balance ≠ Σ POSTED rewards (= posted − reversed) per unit/currency |
| `REVERSED_EVENT_LIVE_REWARDS` | critical | reversed sale with PENDING/APPROVED/POSTED rewards |
| `CALCULATION_TOTAL_MISMATCH` | critical | processed/reversed sale without a calculation, or calculation total ≠ Σ rewards |
| `EVENT_STUCK_RECEIVED` | warning | sale in RECEIVED for more than 15 minutes |
| `PLAN_PAYMENT_LOOKALIKE` | review | sale amount = the subject's own plan payment in the same program within ±2 days (compliance queue) |

Response: `generatedAt`, `healthy` (no critical/warning exception — review items do not count),
`totalExceptions`, `checks[]` (key, label, description, remedy, severity, count, passed), `exceptions[]`
(check, severity, resourceType `reward | ledger_transaction | ledger_account | qualifying_event | member`,
resourceId, programId, summary, details; ≤ `exceptionLimitPerCheck` = 100 rows per check, `truncated`), and
`summary` (rewards and sales by status; per unit/currency: rewards posted vs ledger postings, rewards reversed
vs ledger reversals, expected vs actual payable balance).

`ReconciliationService.countExceptions(): Promise<number>` (exported by `ReconciliationModule`) returns
`totalExceptions` from the same cache; the admin overview uses it.

## Member

| Method | Path | Auth | Query | Response `data` |
|---|---|---|---|---|
| GET | `/users/me/rewards` | signed-in member | `cursor`, `limit`, `status`, `programId`, `from`, `to` (created) | page of `MemberRewardDto` (newest first) |
| GET | `/users/me/rewards/facets` | signed-in member | – | `{ programs: [{ id, name }] }` |
| GET | `/users/me/rewards/:id` | signed-in member | – | `MemberRewardDto`; 404 for anyone else's reward |
| GET | `/users/me/rewards/export.csv` | signed-in member | list filters | `text/csv` of the member's own rewards |
| GET | `/users/me/earnings` | signed-in member | – | `MemberEarningsDto` `{ buckets: EarningsBucketDto[] }` |

`MemberRewardDto` is exactly business rules §10: `id`, `program { id, name }`, `level`, `amountMinor`,
`rewardUnit`, `currencyCode`, `currencyMinorUnits`, `status`, `createdDate`, `approvedDate`, `postedDate`,
`rejectedDate`, `reversedDate` (calendar dates `YYYY-MM-DD` in the program's time zone), `rejectionReason`,
`reversalReason`. Never the sale's subject, sale amount, exact time, external id, customer reference or trace.

`EarningsBucketDto` per (unit, currency): `earnedToDateMinor` = Σ credits − Σ debits on the member's
rewards-payable accounts (posted − reversed, from the ledger), `pendingMinor` = Σ PENDING_APPROVAL +
APPROVED, `reversedMinor` = Σ REVERSED, plus `postedCount`, `pendingCount`, `reversedCount`. Rejected rewards
are listed but never totalled. No buckets when the member has no rewards.

## CSV exports

Streamed (`Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment;
filename="<name>-YYYY-MM-DD.csv"`, `Cache-Control: no-store`), UTF-8 BOM, CRLF rows, RFC 4180 quoting.
**CSV-injection safe:** any cell starting with `=`, `+`, `-`, `@`, tab or carriage return is prefixed with
`'`. Amounts appear twice: `amount` (exact decimal in major units, points as integers) and `amount_minor`.
Admin exports are audited (`rewards.export`, `ledger.export`, with the filters) before streaming; access and
filter errors are returned as normal JSON errors before any byte is sent.

- `/admin/rewards/export.csv`: reward id, created, status, program, level, recipient, amount, unit,
  currency, sale (id, external id, type, source, amount, currency, occurred at, subject), decisions + reasons.
- `/admin/ledger/export.csv`: transaction id, posted at, type, reward/event/program ids, member, account id
  and type, direction, amount, unit, currency, description, posted by.
- `/users/me/rewards/export.csv`: reward id, date, program, level, amount, unit, currency, status, decision
  dates, reasons (the §10 fields only).
