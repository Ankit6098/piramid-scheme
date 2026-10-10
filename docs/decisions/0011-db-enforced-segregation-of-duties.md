# ADR-0011: Segregation of duties enforced in the database

- **Status:** Accepted
- **Date:** 2026-10-10

## Context

The product rule "four eyes on money" ([business-rules.md §0](../business-rules.md#0-compliance-guardrails-fixed-not-configurable),
[§3](../business-rules.md#3-roles-permissions-segregation-of-duties)) means that nobody may
benefit from a financial decision they make themselves. Admins can also be members with uplines
and downlines, so the conflicts are real: a PROGRAM_ADMIN could record a sale for their own
downline and then approve the rewards it pays to themselves.

Application checks alone are not enough. Rewards are written by several paths (HTTP routes, the
reward engine run by the worker and the sweeper, bulk approval, event reversal, the seed and
maintenance scripts), and a new endpoint or a refactor can silently drop a check. The actor of
every decision is recorded anyway, so the data needed to check the rule is on the row.

## Decision

Every segregation-of-duties rule is a **CHECK constraint or trigger on the row that records the
decision**, using the actor columns that are already required:

| Rule | Enforced by |
|---|---|
| Nobody approves, rejects or reverses a reward credited to them | `ck_rewards_sod` (`approved_by_id`, `rejected_by_id`, `reversed_by_id` ≠ `recipient_user_id`) |
| A manual approval names its approver, and the admin who recorded the sale cannot approve its rewards | `trg_rewards_guard` (PENDING_APPROVAL → APPROVED) |
| Rewards from manually recorded sales are never auto-approved; decisions are never pre-filled | `trg_rewards_insert_guard` |
| A member is never rewarded for their own sale; a recipient must be an upline of the subject | `trg_rewards_insert_guard` (closure-table check) |
| An admin cannot record a sale whose subject is themselves or anyone in their downline | `trg_events_insert_guard` (`referral_paths` from recorder to subject, depth ≥ 0) |
| Only a SUPER_ADMIN can publish a policy whose rewards skip approval | `trg_policy_versions_guard` (publisher's roles) |
| A sponsor correction is not performed by the moved member, the previous or new sponsor, or an upline of the new sponsor | `ck_referral_corrections_sod`, `trg_referral_corrections_insert_guard` |
| Nobody grants roles to themselves | `ck_user_roles_not_self_granted` |
| A flag cannot be resolved by its subject | `ck_member_flags_not_self_resolved` |
| At least one ACTIVE SUPER_ADMIN always remains (governance backstop) | deferred `trg_user_roles_keep_super_admin`, `trg_users_keep_super_admin` |

Event reversal needs no separate rule: it writes the caller into `rejected_by_id` /
`reversed_by_id` of every reward of the sale, so `ck_rewards_sod` refuses a reversal by a
recipient of any of them.

The application **mirrors every rule before the database** to give precise errors and UI hints:
`409 CONFLICT` with `details.reason = 'SEGREGATION_OF_DUTIES'` and `details.rule`
(`OWN_REWARD`, `RECORDED_SALE`) for reward decisions, `409 CONFLICT` with `details.reason =
'RECORDER_SOD'` for sale recording, `403 FORBIDDEN` with `details.reason = 'SEGREGATION_OF_DUTIES'`
for corrections, and `viewer: { isRecipient, recordedSale }` hints on reward rows so the UI can
disable buttons. Pure rule functions live in `domain/` (e.g. `rewards/domain/sod.ts`) with unit
tests; every DB rule has an attack case in `test/db-invariants.int-spec.ts`.

## Consequences

- The rules hold for every writer: API, worker, sweeper, seed, scripts and manual SQL. A missing
  application check degrades to `409 INVARIANT_VIOLATION`, never to a self-approved reward.
- Actor columns must always be set truthfully. System actions are explicit: an auto-approved
  reward has `approved_by_id = NULL`, which the triggers accept only for a non-manual sale under a
  policy that skips approval; a system ledger posting has `posted_by_id = NULL`.
- The database message is generic (`INVARIANT_VIOLATION`), so user-facing quality depends on the
  application pre-checks; a DB-level SoD failure in production indicates a bug to report.
- Some checks read other tables (closure rows, roles, the event) inside triggers. They use the
  existing indexes (`referral_paths` PK, `user_roles` PK) and add negligible cost to rare,
  human-paced decisions.
- Rules that are not stated as business rules (for example "an approver must not be in the
  recipient's upline") are deliberately not enforced; adding one is a business-rules change plus a
  migration.

## Alternatives considered

- **Application checks only:** easy to change, but every new code path must remember them, and the
  seed, worker and scripts bypass HTTP guards.
- **A single "approval service" that all writers must call:** still bypassable by direct writes
  and refactors; the database is the only shared choke point.
- **PostgreSQL row-level security with a database role per actor:** strong, but incompatible with
  a pooled application connection and Prisma without per-request role switching and session
  variables, which would add more moving parts than the rules themselves.
