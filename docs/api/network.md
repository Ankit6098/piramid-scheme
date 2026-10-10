# API — Referral network: codes, sponsor, team tree, corrections, flags (slice 3)

Business rules: [§3 roles & SoD](../business-rules.md#3-roles-permissions-segregation-of-duties),
[§6 referral tree](../business-rules.md#6-referral-tree), [§12 fraud signals](../business-rules.md#12-fraud-signals-advisory).
Contracts (request schemas + response types): `packages/shared/src/contracts/referrals.ts`. Conventions
(envelopes, cursors, errors) are in [api.md](../api.md). Implementation: `apps/api/src/modules/referrals/`.

All routes need a session unless marked public. `/admin/*` routes also need an admin role and a TOTP-verified
session (403 `FORBIDDEN` / `MFA_REQUIRED`) plus the listed permission (403 `FORBIDDEN`,
`details.missingPermissions`). Mutations need the CSRF double-submit header (403 `CSRF_FAILED`).

**Privacy (members).** Other members are shown only as a *display name* (first name + last initial, e.g.
`Anita S.`), depth, joined date, a status bucket (`ACTIVE` = account active, `INACTIVE` = anything else),
whether they currently hold an ELIGIBLE enrollment (any program, coverage contains now) and their visible
direct-referral count. Never emails, phones, prices, rewards or sale amounts. Upline members are returned
without ids. A member, path or subtree that is not the caller or a descendant within **10** levels is
reported as **404 `NOT_FOUND`** (never 403), so ids cannot be probed.

**Bounded queries.** Subtree membership, depth, counts and search use the closure table (`referral_paths`,
indexes `(ancestor_id, depth)` / `(descendant_id, depth)`); child lists use the adjacency index
`(sponsor_user_id, attributed_at)` with a per-parent `LIMIT`. Nothing loads a whole tree. A tree response
holds at most `MAX_TREE_RESPONSE_NODES` (600) nodes and ≤ `TREE_CHILDREN_LIMIT` (50) children per node.

## Public

| Method | Path | Auth | Request | Response `data` |
|---|---|---|---|---|
| POST | `/referrals/validate` | public, rate limited (20/min/IP, `auth` throttler) | `{ code }` (1–32 chars; spaces/dashes ignored, case-insensitive) | `{ valid: boolean, sponsorDisplayName?: string }` |

Always 200. `valid: false` never says why (unknown, inactive code, owner not ACTIVE/verified). Errors: 400
`VALIDATION_FAILED`, 403 `CSRF_FAILED`, 429 `RATE_LIMITED`.

## Member: own network (`/users/me/...`)

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/users/me/referral-code` | — | `{ data: { code, link } }` — `link = ${APP_PUBLIC_URL}/register?ref=CODE`. A missing active code is allocated on first use |
| GET | `/users/me/parent` | — | `{ data: MyParentResponse \| null }` (null = no sponsor) |
| GET | `/users/me/referrals` | `?status=ACTIVE\|INACTIVE&cursor&limit` (≤ 100, default 25) | `{ data: DirectReferralDto[], page }`, newest attribution first |
| GET | `/users/me/hierarchy/summary` | — | `{ data: TeamSummaryResponse }` (`maxDepth: 10`) |
| GET | `/users/me/hierarchy/tree` | `?rootId=<self or descendant ≤ 10>&depth=1..3` (default 2) | `{ data: TeamTreeResponse }` |
| GET | `/users/me/hierarchy/children` | `?parentId&cursor&limit` (≤ 100, default 50) | `{ data: DownlineMemberDto[], page }`, oldest attribution first. A parent at depth 10 returns an empty page |
| GET | `/users/me/hierarchy/path/:memberId` | — | `{ data: { nodes: TeamPathNodeDto[] } }` from the caller (depth 0) down to the member |
| GET | `/users/me/hierarchy/search` | `?q` (2–64 chars) `&cursor&limit` (≤ 50, default 20) | `{ data: TeamSearchResultDto[], page }` ordered by depth |

- `MyParentResponse = { sponsor: { displayName, joinedAt, attributedAt, attributionSource: REGISTRATION|ADMIN_CORRECTION }, ancestors: [{ displayName, depth, joinedAt }] (sponsor first, ≤ 10), hasMoreAncestors }`.
- `DownlineMemberDto = { id, displayName, depth, joinedAt, statusBucket, hasEligibleEnrollment, childCount }`
  (`depth` relative to the caller; `childCount` is 0 at depth 10 because deeper members are invisible).
  `DirectReferralDto` adds `attributedAt`.
- `TeamSummaryResponse = { directCount, teamSize, countsByDepth: [{ depth, count }], activeCount, inactiveCount, withEligibleEnrollmentCount, maxDepth }` — over descendants at depth 1..10.
- `TeamTreeResponse = { root: TeamNodeDto, maxDepth: 10, truncated }`. `TeamNodeDto` = `DownlineMemberDto` +
  `children` (≤ 50, oldest first), `childrenLoaded` (false = not part of this response, load lazily),
  `hasMoreChildren` + `childrenCursor` (continue with `/children?parentId=<id>&cursor=<childrenCursor>`).
  Levels are expanded breadth-first; once the node budget is used, remaining branches stay unloaded and
  `truncated` is true.
- **Search** matches the *display name* only (`ILIKE`, wildcards escaped, trigram index on `users.full_name`
  as prefilter), so hidden parts of a name (e.g. a last name) never match. Scope: the caller's descendants at
  depth 1..10.
- Errors: 400 `VALIDATION_FAILED` (bad uuid, depth > 3, short `q`, tampered cursor), 401, 404 `NOT_FOUND`
  (member outside the visible subtree).

## Admin: a member's network (`/admin/members/:id/...`)

Scope: SUPER_ADMIN and FINANCE_REVIEWER read every member. A PROGRAM_ADMIN may open only members enrolled
(any status) in one of their assigned programs — any other member is 404. Inside a tree they see other
members' `displayName` only (`fullName: null`, `status: null`, `inScope: false`); their search only finds
in-scope members. Admin trees have **no depth limit** (`maxDepth: null`; still lazily loaded and bounded).

| Method | Path | Permission | Request | Response `data` |
|---|---|---|---|---|
| GET | `/admin/members/:id/hierarchy` | `members:read` | `?rootId=<:id or a descendant>&depth=1..3` | `AdminTeamTreeResponse` (`AdminTeamNodeDto` = `TeamNodeDto` + `fullName`, `status`, `inScope`; depth relative to `:id`) |
| GET | `/admin/members/:id/hierarchy/summary` | `members:read` | — | `TeamSummaryResponse` over the whole subtree (`maxDepth: null`) |
| GET | `/admin/members/:id/hierarchy/children` | `members:read` | `?parentId&cursor&limit` | page of `AdminDownlineMemberDto` |
| GET | `/admin/members/:id/hierarchy/path/:memberId` | `members:read` | — | `{ nodes: AdminTeamPathNodeDto[] }` from `:id` down to `memberId` |
| GET | `/admin/members/:id/hierarchy/search` | `members:read` | `?q&cursor&limit` | page of `AdminTeamSearchResultDto` (full-name match) |
| GET | `/admin/members/:id/ancestors` | `members:read` | — | `{ memberId, ancestors: AdminAncestorDto[] (sponsor first, all levels), attributionSource, attributedAt }` |

Errors: 400, 403 (role/permission/MFA), 404 (unknown member, out of scope, node outside `:id`'s subtree).

### Sponsor correction (SUPER_ADMIN)

| Method | Path | Permission | Request | Response `data` |
|---|---|---|---|---|
| GET | `/admin/members/:id/sponsor-correction/preview` | `referrals:correct` | `?newSponsorId` | `SponsorCorrectionPreviewResponse` |
| POST | `/admin/members/:id/sponsor-correction` | `referrals:correct` | `{ newSponsorId, reason }` (reason 10–1000 chars); optional `Idempotency-Key` | `SponsorCorrectionResponse` (201) |

`SponsorCorrectionPreviewResponse = { member, currentSponsor | null, newSponsor, affectedMembers (member + subtree), newDepthFromRoot, receivedEventCount, issues: [{ code, message }], canApply }`.
Issue codes: `SELF_SPONSOR`, `CYCLE` (new sponsor inside the member's subtree), `SAME_SPONSOR`,
`SPONSOR_INACTIVE` (new sponsor must be ACTIVE + verified), `SEGREGATION_OF_DUTIES` (performer is the member,
the current or new sponsor, or an upline of the new sponsor), `RECEIVED_EVENTS` (unprocessed sales in the
moved subtree).

The POST runs the DB-enforced protocol in **one** transaction without savepoints: `pg_advisory_xact_lock(7301,1)`
first (`lockReferralTreeExclusive`) → re-evaluate every rule under the lock → INSERT `referral_corrections` →
`setReferralCorrectionId` (`SET LOCAL app.referral_correction_id`) → UPDATE the relationship
(`source = ADMIN_CORRECTION`, `referral_code_id = NULL`, `attributed_at = now()`; a former root member gets an
INSERT instead) → DELETE closure rows linking the subtree to its old strict ancestors → INSERT the cross product
of the new sponsor's ancestors-or-self and the subtree. Audit `referral.correct` (resource `user`, `before:
{ sponsorUserId }`, `after: { sponsorUserId, correctionId, affectedMembers }`, reason). Only future reward
calculations use the new placement; past rewards never change.

`SponsorCorrectionResponse = { correctionId, memberId, previousSponsorId, newSponsorId, affectedMembers, createdAt }`.
Errors: 400 `VALIDATION_FAILED`; 403 `FORBIDDEN` (`details.reason = SEGREGATION_OF_DUTIES`, `details.issues`);
404 (member / new sponsor); 409 `REFERRAL_CYCLE` (self or cycle), 409 `INVALID_STATE_TRANSITION` (same sponsor,
inactive sponsor, RECEIVED events — `details.issues`); 409 `INVARIANT_VIOLATION` if a DB trigger still refuses.
Known gap: a sale recorded for a subtree member concurrently with the correction is not blocked (event intake
does not take the tree lock); it is processed with the new placement.

## Admin: flags (`flags:manage`)

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/admin/flags` | `?status=OPEN\|RESOLVED\|DISMISSED&kind=<KIND>&userId&cursor&limit` | `{ data: FlagDto[], page }`, newest first |
| GET | `/admin/flags/:id` | — | `{ data: FlagDto }` |
| POST | `/admin/flags` | `{ userId, details }` (details 10–2000) → kind `MANUAL_REPORT` | `{ data: FlagDto }` (201); audit `flag.create` |
| POST | `/admin/flags/:id/resolve` | `{ status: RESOLVED\|DISMISSED, resolution }` (10–1000) | `{ data: FlagDto }` (200); audit `flag.resolve` / `flag.dismiss` |

`FlagDto = { id, kind, details, status, user: { id, fullName, status }, createdBy | null, resolvedBy | null, resolution, resolvedAt, createdAt, updatedAt }`.
Errors: 400; 403 (`flags:manage` missing, or the caller is the flag's subject — `ck_member_flags_not_self_resolved`);
404; 409 `INVALID_STATE_TRANSITION` when the flag is not OPEN (conditional update).

### Fraud heuristic `SHARED_IP_REGISTRATIONS` (outbox-driven)

`ReferralsService.attachNewMember` enqueues outbox topic **`fraud.registration-attributed`** (`{ childUserId }`,
dedupe key `fraud-attribution:<childUserId>`) inside the registration transaction whenever the attribution has
a sponsor and a valid registration IP; the worker therefore only sees committed attributions.
`FraudSignalsService` (registered handler) reads the relationship and counts REGISTRATION attributions for the
same (sponsor, `registration_ip`) in the 24 h window ending at that attribution. ≥ 3 → upsert the OPEN flag on
the **sponsor** with dedupe key `SHARED_IP:<sponsorId>:<ip>` (`ON CONFLICT (dedupe_key) WHERE status = 'OPEN'`,
unique while OPEN); the text reports the latest 24 h cluster (so redeliveries/out-of-order delivery never
shrink it); a new flag is audited as `flag.raise` by `SYSTEM`. An attribution older than an admin's
resolution/dismissal of the same key is not re-raised; later ones raise a new flag. Corrections
(`ADMIN_CORRECTION`) are never counted. Flags are advisory and never change balances.
