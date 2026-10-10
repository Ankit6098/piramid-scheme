# API — Settings, offerings, programs & enrollments (slice 2)

Business rules: [§1 platform settings & currencies](../business-rules.md#1-platform-settings--currencies),
[§4 offerings & programs](../business-rules.md#4-offerings--programs), [§5 enrollment](../business-rules.md#5-enrollment).
Contracts (request schemas + response types): `packages/shared/src/contracts/settings.ts`, `offerings.ts`,
`programs.ts`, `enrollments.ts`. Conventions (envelopes, cursors, errors, amounts as decimal strings of minor
units) are in [api.md](../api.md).

All `/admin/*` routes need an admin role, a TOTP-verified session and the listed permission (403 `FORBIDDEN` /
`MFA_REQUIRED`). **Program-scoped** routes call `assertProgramAccess`: SUPER_ADMIN everywhere, PROGRAM_ADMIN only
for assigned programs (403 `FORBIDDEN` otherwise; lists are filtered), FINANCE_REVIEWER read-only. Every mutation
is audited in its transaction (with `programId` for program-scoped entities). Mutations need the CSRF
double-submit header. Prices and payments are minor units of the **program currency**; plan prices pay for the
plan and never trigger rewards.

## Settings

| Method | Path | Permission | Body / query | Response `data` |
|---|---|---|---|---|
| GET | `/settings/public` | public | – | `PublicSettingsDto` `{ rewardUnit, currencyCode, currencyMinorUnits, pointsLabel }` |
| GET | `/admin/settings` | settings:write | – | `PlatformSettingsDto` (+ `pointsPerCurrencyUnit`, `defaultRewardBudgetBps`, `payoutsEnabled` (always false), `version`, `updatedAt`, `updatedBy`, `liveProgramCount`, `liveProgramCurrencyCodes`) |
| PUT | `/admin/settings` | settings:write | `updatePlatformSettingsSchema`: `expectedVersion`, `reason` (≥ 10), any of `rewardUnit`, `currencyCode`, `pointsLabel`, `pointsPerCurrencyUnit` (1..1,000,000), `defaultRewardBudgetBps` (1..5000). Unknown keys rejected | `PlatformSettingsDto` |
| GET | `/admin/currencies` | settings:write | – | `CurrencyDto[]` `{ code, name, minorUnits }` |

PUT writes only fields that actually change (no change → same version, no audit). Errors: 400
`VALIDATION_FAILED` (missing reason, unknown key such as `payoutsEnabled`, out of range, unknown currency);
409 `STALE_VERSION`; 409 `INVARIANT_VIOLATION` with `details.programs[]` when the currency would change while a
SCHEDULED/ACTIVE/PAUSED program uses another currency (also enforced by `trg_platform_settings_guard`). The
minor units come from `currencies`. Audit: `settings.update` (changed fields before/after + new version, reason).

## Offerings

| Method | Path | Permission | Body / query | Response `data` |
|---|---|---|---|---|
| GET | `/admin/offerings` | programs:read | `cursor`, `limit`, `status`, `kind`, `q` (name/SKU) | page of `OfferingDto`, `createdAt desc` |
| GET | `/admin/offerings/:id` | programs:read | – | `OfferingDto` |
| POST | `/admin/offerings` | offerings:write | `createOfferingSchema` `{ name, kind, sku?, description? }` | 201 `OfferingDto` (status INACTIVE) |
| PATCH | `/admin/offerings/:id` | offerings:write (+ offerings:approve when the offering is ACTIVE) | `updateOfferingSchema` (partial) | `OfferingDto` |
| DELETE | `/admin/offerings/:id` | offerings:write | – | 204 (only INACTIVE offerings no program/sale uses) |
| POST | `/admin/offerings/:id/approve` | offerings:approve | `{ reason? }` (body optional) | `OfferingDto` (ACTIVE, approver recorded) |
| POST | `/admin/offerings/:id/deactivate` | offerings:approve | `{ reason }` | `OfferingDto` (INACTIVE) |

`OfferingDto` carries `programCount` and `liveProgramCount`. Errors: 409 `CONFLICT` with `details.issues[path=sku]`
for a duplicate SKU; 409 `INVALID_STATE_TRANSITION` (approve an ACTIVE / deactivate an INACTIVE / delete a used or
active offering). Audit: `offering.create|update|approve|deactivate|delete`.

## Programs (admin)

| Method | Path | Permission | Body / query | Response `data` |
|---|---|---|---|---|
| GET | `/admin/programs` | programs:read (scoped list) | `cursor`, `limit`, `status` (repeatable), `offeringId`, `q` (name/code) | page of `AdminProgramSummaryDto`, `createdAt desc` |
| POST | `/admin/programs` | programs:write | `createProgramSchema` (code slug, name, offeringId, timezone, startsAt, endsAt?, enrollmentOpensAt? (= startsAt), enrollmentClosesAt?, maxRewardDepth, lateEventGraceDays, eligibility `{ minAccountAgeDays?, requireSponsor? }`, termsVersion, termsText?) | 201 `AdminProgramDetailDto` (DRAFT; unit/currency/minor units snapshotted from settings) |
| GET | `/admin/programs/:id` | programs:read (scoped) | – | `AdminProgramDetailDto` |
| PATCH | `/admin/programs/:id` | programs:write (scoped) | `updateProgramSchema`: `expectedVersion` + changed fields, `reason?` | `AdminProgramDetailDto` |
| DELETE | `/admin/programs/:id` | programs:write (scoped) | – | 204 |
| POST | `/admin/programs/:id/publish` | programs:publish (scoped) | `{ expectedVersion?, reason? }` (body optional) | `AdminProgramDetailDto` (SCHEDULED if `startsAt` is ahead, else ACTIVE) |
| POST | `/admin/programs/:id/pause` | programs:publish (scoped) | `{ expectedVersion?, reason }` | `AdminProgramDetailDto` (PAUSED) |
| POST | `/admin/programs/:id/resume` · `/complete` · `/archive` | programs:publish (scoped) | `{ expectedVersion?, reason? }` (body optional) | `AdminProgramDetailDto` |

`AdminProgramDetailDto` = summary (status, offering ref, unit/currency snapshot, dates, `version`, active option /
active / pending enrollment counts) + `description`, `maxRewardDepth`, `lateEventGraceDays`, `eligibility`,
`termsVersion`, `termsText`, `createdBy`, `updatedBy`, `options[]` (`ProgramOptionDto`), `policySummary`
(draft/published/retired counts, `current`, `upcoming`), `enrollmentCounts` per status, `statusHistory[]` (from
`program_status_changes`, newest first, `changedBy = null` for the scheduler), `adminCount`, `publishChecks[]`
(`ACTIVE_OPTION`, `OFFERING_ACTIVE`, `DATES_VALID`, `PUBLISHED_POLICY`), `editableFields[]`, `allowedActions[]`,
`canDelete`.

Rules:
- **Edit** — only changed fields count; `editableFields` per status: DRAFT all; SCHEDULED name, description, terms,
  start, enrollment opening, end, enrollment close; ACTIVE/PAUSED name, description, terms, end, enrollment close;
  COMPLETED name, description, terms; ARCHIVED nothing. Locked fields → 409 `INVALID_STATE_TRANSITION`
  (`details.fields`). After publication the end can't move into the past or be removed, the start (SCHEDULED) must
  stay in the future, and new terms text needs a new `termsVersion` (400 with `details.issues`). Lowering
  `maxRewardDepth` below a published policy's depth → 400. Stale version → 409 `STALE_VERSION`.
- **Lifecycle** (DB state machine): publish DRAFT → SCHEDULED|ACTIVE; pause ACTIVE → PAUSED (reason required);
  resume PAUSED → ACTIVE (not after the end date); complete ACTIVE|PAUSED → COMPLETED (sets `endsAt = now` when
  later and pulls enrollment dates in); archive COMPLETED → ARCHIVED. Invalid transition → 409
  `INVALID_STATE_TRANSITION`. Publish preconditions (409 with `details.checks`): ≥ 1 active option, ACTIVE
  offering, consistent dates with the end/close still ahead, ≥ 1 PUBLISHED policy version. The reason goes to
  `program_status_changes` via `set_config('app.status_reason', …, true)`, the actor via `updated_by_id`.
- **Delete** — DRAFT only, without published/retired policy versions or API clients (409 otherwise).
- A PROGRAM_ADMIN who creates a program is assigned to it automatically (audited `creatorAssigned`).
- Audit: `program.create|update|delete|publish|pause|resume|complete|archive`, scheduler `program.auto_start|auto_complete` (system).

### Options

| Method | Path | Permission | Body | Response `data` |
|---|---|---|---|---|
| POST | `/admin/programs/:id/options` | programs:write (scoped) | `createProgramOptionSchema` `{ name, description?, priceMinor, billingFrequency, durationDays, renewalPolicy = MANUAL, sortOrder? }` | 201 `ProgramOptionDto` (program currency) |
| PATCH | `/admin/programs/:id/options/:optionId` | programs:write (scoped) | `updateProgramOptionSchema` (partial, incl. `isActive`) | `ProgramOptionDto` |
| POST | `/admin/programs/:id/options/:optionId/deactivate` · `/activate` | programs:write (scoped) | – | `ProgramOptionDto` |

Duration must fit the frequency (MONTHLY 28–31, QUARTERLY 89–92, HALF_YEARLY 181–184, YEARLY 365–366, ONE_TIME
1–3660; 400 `details.issues[path=durationDays]`). Price, duration and frequency of an option with enrollments never
change → 409 "create a new option". A live program keeps ≥ 1 active option (409). No options on COMPLETED/ARCHIVED
programs; archived programs are read-only. Audit: `program_option.create|update|activate|deactivate`.

### Admin assignments

| Method | Path | Permission | Body | Response `data` |
|---|---|---|---|---|
| GET | `/admin/programs/:id/admins` | programs:read (scoped) | – | `ProgramAdminDto[]` (emails masked unless the caller has roles:assign) |
| GET | `/admin/programs/:id/admins/candidates` | roles:assign | – | `ProgramAdminCandidateDto[]` (active PROGRAM_ADMIN users) |
| PUT | `/admin/programs/:id/admins` | roles:assign | `{ userIds: uuid[], reason? }` (replaces the set) | `ProgramAdminDto[]` |

Only active users holding PROGRAM_ADMIN can be assigned (400 `details.issues[path=userIds.<i>]`); nobody assigns
themselves (403). Scopes apply on the admin's next request. Audit: `program.admins_set` (before/after ids).

## Programs (member catalogue)

| Method | Path | Permission | Query | Response `data` |
|---|---|---|---|---|
| GET | `/programs` | session | `cursor`, `limit` | page of `MemberProgramDto` — ACTIVE/SCHEDULED programs with ≥ 1 active option, `startsAt desc` |
| GET | `/programs/:idOrCode` | session | – | `MemberProgramDetailDto` (+ `termsText`) |

`MemberProgramDto`: program info, offering `{ name, kind, description }`, currency + minor units, time zone, dates,
`enrollmentOpen`, `eligibility`, `myEligibility { eligible, reasons[] }`, `termsVersion`, active `options[]`
(`priceMinor` strings) and `myEnrollments[]` (caller's PENDING/ACTIVE). No reward policy data. DRAFT programs are
404; PAUSED/COMPLETED/ARCHIVED programs are visible only to members with an enrollment in them.

## Enrollments

| Method | Path | Permission | Body / query | Response `data` |
|---|---|---|---|---|
| POST | `/programs/:id/enrollments` | session | `{ optionId, acceptTerms: true, termsVersion? }` | 201 `MyEnrollmentDto` (free → ACTIVE, paid → PENDING) |
| GET | `/users/me/enrollments` | session | `cursor`, `limit`, `status` (repeatable), `programId` | page of `MyEnrollmentDto`, `createdAt desc` |
| POST | `/users/me/enrollments/:id/cancel` | session (own) | `{ reason? }` (body optional) | `MyEnrollmentDto` |
| GET | `/admin/enrollments` | enrollments:manage (scoped list) | `cursor`, `limit`, `status` (repeatable), `programId`, `userId`, `q` (member name/email, payment ref) | page of `AdminEnrollmentDto` |
| GET | `/admin/enrollments/:id` | enrollments:manage (scoped) | – | `AdminEnrollmentDto` |
| POST | `/admin/enrollments/:id/activate` | enrollments:manage (scoped) | `{ paymentReference, paymentAmountMinor }` | `AdminEnrollmentDto` (ACTIVE, ELIGIBLE) |
| POST | `/admin/enrollments/:id/reject` | enrollments:manage (scoped) | `{ reason }` | `AdminEnrollmentDto` (REJECTED, INELIGIBLE) |
| POST | `/admin/enrollments/:id/cancel` | enrollments:manage (scoped) | `{ reason }` | `AdminEnrollmentDto` (CANCELLED) |

`MyEnrollmentDto`: status, eligibility, program ref (currency + minor units, time zone), immutable `option`
snapshot (`priceMinor` string), `termsVersion`, coverage `[effectiveFrom, effectiveTo)`, `upcoming` (queued renewal),
`cancelledAt`, `statusReason`, `paymentRecordedAt`, `canCancel`. `AdminEnrollmentDto` adds `member { id, fullName,
email }`, `sponsor`, `paymentReference`, `paymentAmountMinor`, `paymentRecordedBy`, `allowedActions[]`.

Rules (serialized per member+program with `pg_advisory_xact_lock(7302, hashtext(user:program))`):
- **Enroll**: program ACTIVE with an open window (409 `PROGRAM_NOT_ENROLLABLE`; DRAFT → 404), option active in the
  program (400 `issues[path=optionId]`), member ACTIVE + verified (403 `EMAIL_NOT_VERIFIED`), eligibility rules
  (409 `NOT_ELIGIBLE`, `details.reasons`), terms version still current (409 `CONFLICT`), no PENDING enrollment and no
  queued renewal, current plan renewable (renewal policy ≠ NONE) (409 `ALREADY_ENROLLED`). Snapshot =
  `{ optionId, name, priceMinor, currencyCode, billingFrequency, durationDays, renewalPolicy }`, plus `termsVersion`
  and the sponsor. Free plans activate with coverage from `max(now, end of the current period)`.
- **Activate** (PENDING only; program ACTIVE or PAUSED; member active): `paymentAmountMinor` ≥ plan price (400);
  `paymentReference` unique across enrollments and never equal to a recorded sale id (409 `issues[path=paymentReference]`).
  Coverage = `max(now, end of the member's current period)` + duration (renewal without a gap).
- **Cancel** (member own / admin with reason): PENDING → CANCELLED (INELIGIBLE); ACTIVE → CANCELLED with `effectiveTo`
  shortened to `max(now, effectiveFrom)` (queued renewal → empty period). Ended coverage or terminal states → 409.
- **Reject**: PENDING → REJECTED with reason.
- Notifications (`notification.create`): `enrollment.pending|activated|rejected|cancelled|expired`; emails
  (`enrollment-status`) for admin activation/rejection/cancellation.
- Audit: `enrollment.create|activate|reject|cancel`, scheduler `enrollment.expire` (system).

## Scheduled jobs

| Job | Every | Effect |
|---|---|---|
| `programs-status-transitions` | 60 s | SCHEDULED → ACTIVE once `startsAt` passed; ACTIVE/PAUSED → COMPLETED once `endsAt` passed. Per-program transaction, `FOR UPDATE SKIP LOCKED`, reason "Start/End date reached", actor = system |
| `enrollments-expiry` | 5 min | ACTIVE → EXPIRED once `effectiveTo` passed (eligibility kept for historical coverage), batches of 200, audited as system, member notified |
