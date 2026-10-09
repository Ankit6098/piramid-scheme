# ADR-0007: Sale-funded rewards and the 50 % budget cap (compliance guardrail)

- **Status:** Accepted
- **Date:** 2026-10-09

## Context

Multi-level referral rewards are legitimate when they share revenue from **real sales of real
products or services to customers**. They become a pyramid-style scheme when participants are
paid mainly for **recruiting**, for example from joining fees, or when returns are promised. The
product owner agreed to non-negotiable rules
([business-rules.md §0](../business-rules.md#0-compliance-guardrails-fixed-not-configurable)). The
system must make the non-compliant configurations **impossible, not merely discouraged**.

## Decision

1. **Only sales fund rewards.** Rewards are created only from a `QualifyingEvent` whose type is
   `PRODUCT_SALE`, `SERVICE_COMPLETED` or `SUBSCRIPTION_RENEWAL`, and only for a sale of the
   program's ACTIVE `Offering`. The enum has **no** registration, referral or enrollment event
   type. Program option prices (plans) are not reward triggers, and the engine has no code path
   from registration or enrollment to a reward.
2. **Budget cap ≤ 50 %.** A policy's total reward budget per event is `budget_bps` of the sale
   (after the POINTS conversion). It is enforced in three independent places:
   - the DB CHECK `ck_policy_versions_budget` (`budget_bps BETWEEN 1 AND 5000`);
   - the policy validator: Σ percentage bps ≤ `budget_bps`, and the dry-run warns when fixed
     amounts exceed the budget;
   - the engine, which allocates in level order and never exceeds the remaining budget.

   Every calculation also stores `budget_minor` and `total_allocated_minor`, and the CHECK
   `ck_calculations_amounts` guarantees allocated ≤ budget. `platform_settings` defaults are
   capped the same way (`ck_platform_settings_budget`).
3. **No guaranteed returns.** The UI never shows projected or guaranteed income. Plans are
   described as plans for the offering, not investments.
4. **No payouts.** The ledger records liabilities (`MEMBER_REWARDS_PAYABLE`). Payout execution is
   not implemented, and `platform_settings.payouts_enabled` stays `false` until legal, KYC and
   payment-provider approvals exist (future module, separate ADR).
5. **Auditability.** Policies are versioned, effective-dated and immutable once published. A
   calculation stores a full trace. Rewards require approval by default, and
   approvals/reversals post double-entry ledger transactions.

## Consequences

- A misconfigured or malicious admin cannot create a recruitment-funded or > 50 % payout plan.
  The database rejects it.
- Programs need a real Offering and real sale events (recorded by admins or the API) before any
  reward exists.
- Changing these guardrails requires a new ADR, owner and legal sign-off, and a migration. They
  are deliberately not settings.
- Contributors must not add features that pay ancestors for recruitment alone (see CLAUDE.md).

## Alternatives considered

- **A configurable cap per program:** rejected. A setting can be raised; a CHECK is a hard
  guarantee.
- **Rewards on enrollment payments:** rejected outright as recruitment-funded compensation.
