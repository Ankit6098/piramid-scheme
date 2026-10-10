# API — Admin operations, notifications & member dashboard (slice 6)

Business rules: [§2 accounts](../business-rules.md#2-accounts--authentication), [§3 roles & SoD](../business-rules.md#3-roles-permissions-segregation-of-duties),
[§10 what members see](../business-rules.md#10-what-members-see), [§11 reconciliation](../business-rules.md#11-reconciliation),
[§13 audit](../business-rules.md#13-audit). Contracts (request schemas + response types):
`packages/shared/src/contracts/admin.ts`. Conventions (envelopes, cursors, errors, amounts as decimal strings of
minor units) are in [api.md](../api.md).

All `/admin/*` routes need an admin role and a TOTP-verified session (403 `FORBIDDEN` / `MFA_REQUIRED`), plus the
listed permission (403 `FORBIDDEN` with `details.missingPermissions`). Mutations need the CSRF double-submit
header (403 `CSRF_FAILED`). Amounts are summed per reward unit / currency and never across them.

**Program scope.** SUPER_ADMIN and FINANCE_REVIEWER see platform-wide data. A PROGRAM_ADMIN sees only data of
the programs assigned to them; "members" are then members holding an enrollment (any status) in one of those
programs. Anything outside the scope behaves as missing (404), filtering by an unassigned program is 403.

## Admin overview

| Method | Path | Permission | Response `data` |
|---|---|---|---|
| GET | `/admin/overview` | any admin | `AdminOverviewDto` |

`AdminOverviewDto`:

| Field | Meaning |
|---|---|
| `scope`, `scopedProgramCount` | `ALL`, or `PROGRAMS` with the number of assigned programs |
| `users` | `{ total, verified, suspended }` (scoped: enrolled members) |
| `activePrograms`, `pendingEnrollments` | programs with status ACTIVE; enrollments PENDING |
| `sales30d` | `{ count, byCurrency: [{ currencyCode, count, amountMinor }] }` — qualifying sales (RECEIVED/PROCESSED) whose `occurredAt` falls in the 30 UTC days ending today (same window as `daily`, so `count = Σ daily.sales`) |
| `pendingRewardApprovals` | `{ count, byUnit: AmountBucketDto[] }` — rewards PENDING_APPROVAL |
| `postedRewards` | `AmountBucketDto[]` — rewards currently POSTED (posted, not reversed) |
| `reconciliation` | `{ exceptionCount, source }`. Platform-wide callers: `ReconciliationService.countExceptions()` (`source: "reconciliation"`, cached ~60 s). Program admins, or when the report fails: built-in scoped subset (`source: "basic"`) = rewards whose status disagrees with the ledger + events RECEIVED for more than 15 minutes |
| `openFlags` | OPEN member flags; `null` for program-scoped callers |
| `deadOutboxMessages` | DEAD outbox rows; SUPER_ADMIN only, otherwise `null` |
| `recentActions` | last 10 `AuditLogListItemDto` — all entries for `audit:read` holders, entries of assigned programs for program admins |
| `daily` | 30 points `{ date: "YYYY-MM-DD" (UTC), registrations, sales, rewardsPosted }`, oldest first. `rewardsPosted` counts `REWARD_POSTING` ledger transactions |

`AmountBucketDto = { rewardUnit, currencyCode, count, amountMinor }`.

## Members

| Method | Path | Permission | Body / query | Response `data` |
|---|---|---|---|---|
| GET | `/admin/members` | members:read | `q?` (name/email fragment, ≤ 120), `status?` (UserStatus), `role?` (RoleKey), `programId?`, `cursor?`, `limit?` (1..100, default 25) | page of `AdminMemberListItemDto`, newest first |
| GET | `/admin/members/:id` | members:read | – | `AdminMemberDetailDto` |
| POST | `/admin/members/:id/suspend` | members:write | `{ reason }` (10..1000 chars) | `{ id, status: "SUSPENDED", sessionsRevoked }` |
| POST | `/admin/members/:id/reactivate` | members:write | `{ reason }` | `{ id, status: "ACTIVE", sessionsRevoked: 0 }` |
| PUT | `/admin/members/:id/roles` | roles:assign | `{ roles: RoleKey[], reason }` — the complete role set (MEMBER is always kept) | `{ roles, granted, revoked, sessionsRevoked }` |
| POST | `/admin/members/:id/password-reset` | members:write + roles:assign, **SUPER_ADMIN role** | `{ reason }` (10..1000 chars) | `{ id, sentTo (masked), expiresAt, sessionsRevoked }` |

**Search.** `q` is matched case-insensitively against `full_name` and `email` with `ILIKE '%q%'` (served by the
`pg_trgm` GIN indexes; `%`, `_` and `\` are matched literally). Sort `(createdAt desc, id desc)`; the cursor is
that key.

`AdminMemberListItemDto = { id, fullName, email, status, emailVerified, roles, activeEnrollments, openFlags,
createdAt, lastLoginAt }` — `activeEnrollments` counts ACTIVE enrollments within the caller's scope; `openFlags`
is 0 for program-scoped callers. Emails are visible to admins; secrets never are.

`AdminMemberDetailDto` — profile (`email`, `phone`, `status`, `emailVerifiedAt`, `suspendedAt`,
`suspensionReason`, `lastLoginAt`), `roles: [{ role, grantedAt, grantedBy }]`, `programScopes` (PROGRAM_ADMIN
assignments), `hasTotpFactor`, `referralCode`, `sponsor { id, fullName, email } | null`,
`team { directReferrals, totalDescendants }`, `enrollments` (scoped; option name and price from the immutable
snapshot), `rewardSummary: RewardSummaryBucketDto[]` (scoped; earned from the ledger, see below),
`openFlags` (`null` for program-scoped callers) and `can { suspend, reactivate, changeRoles, sendPasswordReset }`
(UI hints; every action is re-checked).

**Suspend / reactivate rules.** Not your own account (403); only a SUPER_ADMIN may suspend or reactivate a user
holding an admin role (403); suspend requires ACTIVE, reactivate requires SUSPENDED (409
`INVALID_STATE_TRANSITION`). Suspension sets `suspendedAt` + `suspensionReason` and revokes all of the member's
sessions (`revoke_reason = suspended`); reactivation clears them and notifies the member
(`account.reactivated`). Audit: `member.suspend` / `member.reactivate`, resource `user`, `before/after.status`,
the reason.

**Roles rules.** Never your own roles (403). Unknown role keys → 400. A no-op (same set) returns 200 with nothing
changed, no audit and no session revocation. Otherwise: rows inserted with `granted_by_id = actor`, removed
roles deleted, **all the member's sessions revoked** (`roles_changed`), audit `member.roles.update`
(`before.roles`, `after.{roles, granted, revoked, sessionsRevoked}`), member notified
(`account.roles_changed`). PROGRAM_ADMIN program assignments are managed on the programs side
(`PUT /admin/programs/:id/admins`).

**Admin-triggered password reset.** Self-service reset is disabled for admin-role accounts
([business rules §2](../business-rules.md#2-accounts--authentication)); this is how they recover (it works for
plain members too). Only a SUPER_ADMIN (both permissions **and** the role — `403` "Only a Super Admin…"
otherwise), never for yourself (`403`), ACTIVE accounts only (`409 INVALID_STATE_TRANSITION`), unknown id
`404`. One transaction: `AuthService.issueAdminPasswordReset` emails a `PASSWORD_RESET` code (OtpMailer; the
challenge records the caller's session as issuer) plus an "an administrator started a password reset" notice
(email + in-app `security.password_reset_started`) → **all the member's sessions revoked**
(`admin_password_reset`) → audit `member.password_reset.send` (`after.{challengeId, sentTo (masked), expiresAt,
adminAccount, sessionsRevoked}`, the reason) → every ACTIVE SUPER_ADMIN (including the caller) gets an email +
in-app notice with the masked address and the reason. The code limits apply explicitly: `429 OTP_COOLDOWN`
(60 s), `429 RATE_LIMITED` (5/hour), `429 OTP_TOO_MANY_ATTEMPTS` (24 h block), each with `Retry-After` —
refused requests change nothing. The password is unchanged until the member submits the code on
`/reset-password` (`POST /auth/password/reset`), which for admin accounts accepts only codes issued this way
by a still-ACTIVE SUPER_ADMIN (see [identity.md](identity.md#post-authpasswordreset--public--limit-auth--200)).

**Last Super Admin.** The status and role commands lock the SUPER_ADMIN `roles` row (the row the DB trigger locks), then check
that another ACTIVE SUPER_ADMIN remains before removing/suspending one. The deferred DB trigger is the backstop;
either way the response is 409 `INVARIANT_VIOLATION` with message "At least one active Super Admin must
remain…" and `details.rule = "LAST_SUPER_ADMIN"`.

## Audit log

| Method | Path | Permission | Query | Response `data` |
|---|---|---|---|---|
| GET | `/admin/audit` | audit:read | `actorId?`, `action?` (prefix, e.g. `member.`), `resourceType?`, `resourceId?`, `programId?`, `from?` / `to?` (ISO date-times with offset, inclusive), `cursor?`, `limit?` | page of `AuditLogListItemDto`, `(createdAt desc, id desc)` |
| GET | `/admin/audit/:id` | audit:read | – | `AuditLogDetailDto` |

`AuditLogListItemDto = { id, createdAt, action, resourceType, resourceId, program { id, code, name } | null,
actor { id, fullName } | null (system), actorRoles, reason, changedFields }`. The detail adds `before`, `after`
(allow-listed, masked snapshots as stored), `requestId`, `ipAddress` and
`changes: [{ path, kind: "added" | "removed" | "changed", before, after }]` — a field-level diff (nested objects
and arrays walked with dotted paths up to depth 4, at most 200 changes). `from > to` → 400. A caller limited to
programs (no such role holds `audit:read` today) would only see entries of those programs.

## Notifications (signed-in user)

| Method | Path | Query / body | Response `data` |
|---|---|---|---|
| GET | `/users/me/notifications` | `unread?` (`true`/`false`), `cursor?`, `limit?` | page of `NotificationDto`, newest first |
| GET | `/users/me/notifications/unread-count` | – | `{ count }` |
| POST | `/users/me/notifications/:id/read` | – | `NotificationDto` (idempotent: keeps the first `readAt`) |
| POST | `/users/me/notifications/read-all` | – | `{ updated }` |

`NotificationDto = { id, type, title, body, data, readAt, createdAt }`. Every query is keyed by the caller's user
id: another user's notification id → 404 `NOT_FOUND`, never modified. Notifications are created by other modules
through `NotificationsService.notify(tx, …)` (outbox → worker insert, deduplicated by the outbox id). Types
starting with `announcement` are shown as dashboard announcements while unread.

## Member dashboard

| Method | Path | Response `data` |
|---|---|---|
| GET | `/users/me/dashboard` | `MemberDashboardDto` |

`MemberDashboardDto`:

- `user { id, fullName, firstName, status, emailVerified, memberSince }`
- `enrollments { active, pending, items[≤5] }` — items: `{ id, program { id, code, name }, optionName, status
  (ACTIVE|PENDING), eligibilityStatus, effectiveFrom, effectiveTo }`
- `referrals { directCount, teamSize }` — `teamSize` counts descendants up to depth 10 (member visibility limit)
- `rewards: RewardSummaryBucketDto[]` — per (unit, currency): `earnedMinor` = Σ CREDIT − Σ DEBIT on the member's
  payable ledger accounts, `pendingMinor` = Σ PENDING_APPROVAL + APPROVED, `reversedMinor` = Σ REVERSED;
  rejected rewards are never totalled; all-zero buckets are omitted
- `unreadNotifications`
- `recentActivity[≤10]`, newest first: `{ kind: "REWARD", rewardId, programName, level, amountMinor, rewardUnit,
  currencyCode, status, at }` (the time of the reward's current status) or `{ kind: "NOTIFICATION",
  notificationId, type, title, body, read, at }`
- `announcements[≤3]` — unread `announcement*` notifications

Privacy: only the caller's own data. Reward activity never includes the sale's subject, sale amount,
`occurredAt`, external id, customer reference or calculation trace.
