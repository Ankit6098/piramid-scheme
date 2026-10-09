# ADR-0004: Integer minor units, and a MONEY/POINTS reward unit

- **Status:** Accepted
- **Date:** 2026-10-09

## Context

Prices, sale amounts, reward amounts and ledger entries must be exact. Rounding must be
deterministic and auditable (policies choose `HALF_UP`, `HALF_EVEN` or `DOWN`). Totals must
reconcile to the minor unit. JavaScript `number` is a binary float, and beyond 2^53 it cannot
represent every integer.

The operator also needs to run programs whose rewards are either **real currency** or **non-cash
points**, without forking the data model.

## Decision

**Amounts**

- Every monetary or points value is an **integer count of minor units**, stored as PostgreSQL
  `BIGINT` in `*_minor` columns: `price_minor`, `amount_minor`, `budget_minor`,
  `fixed_amount_minor`, `cap_minor` and so on.
- Rates are **integer basis points** (`*_bps`, 100 bps = 1 %, 10 000 = 100 %).
- In TypeScript amounts are `bigint` end to end (Prisma `BigInt`). Over HTTP they are **decimal
  strings** (`"amountMinor": "150000"`), validated by `minorAmountSchema` in `@app/shared`. JSON
  numbers are never used for money or points, because JSON parsers lose precision.
- Arithmetic is integer-only. Percentages are `base × bps / 10 000`, followed by the policy's
  explicit rounding mode, implemented on `bigint`. Budgets round **down**.
- UI parsing and formatting go only through `@app/shared` (`decimalToMinor`,
  `minorToDecimalString`, `formatAmount`). Floats are never used.

**Reward unit**

- `platform_settings.reward_unit` is `MONEY` or `POINTS`, with `currency_code` +
  `currency_minor_units` (ISO 4217) and `points_label` / `points_per_currency_unit`.
- A **program snapshots** `reward_unit` + `currency_code` at creation. Once it leaves DRAFT, a
  trigger freezes them. Rewards, calculations, ledger accounts and entries each **store their own
  unit + currency**, so history renders correctly after settings change.
- POINTS mode converts the sale into a points base:
  `round_down(amount_minor × points_per_currency_unit / 10^minor_units)`. Points have 0 minor units.
- Ledger accounts are unique per (type, owner, unit, currency), and entries must match their
  account's unit and currency (trigger). Units and currencies therefore never mix inside a
  balance.

## Consequences

- No float rounding drift, and reconciliation is exact.
- Every API consumer must treat amounts as strings and convert with `BigInt`. `@app/shared`
  provides the helpers, and a lint or review rule forbids `Number(amountMinor)` arithmetic.
- `bigint` is not JSON-serializable by default. The API has a JSON-safe interceptor that
  serializes `bigint` as a string.
- Currency changes are blocked while live programs use another currency. Switching the reward
  unit affects only new programs.

## Alternatives considered

- **`NUMERIC(p,s)` + decimal library:** exact, but every layer needs a decimal type, and scale
  differs by currency (JPY 0, INR 2, some 3). Integer minor units are simpler and faster.
- **Floats with rounding at display:** rejected. Errors accumulate and the system cannot reconcile.
- **Separate tables for points and money:** duplicates the engine and the ledger. A unit column
  plus unique-per-unit accounts is enough.
