# ADR-0002: Prisma for data access, raw SQL for invariants

- **Status:** Accepted
- **Date:** 2026-10-09

## Context

We want type-safe queries and a migration workflow. The business also has invariants that are
critical to rewards and money and that an ORM schema cannot express. Some examples:

- total reward budget ≤ 50 % of the sale (`budget_bps ≤ 5000`);
- published policy versions are immutable and their effective ranges never overlap;
- the ledger is append-only and every transaction balances;
- referral attribution changes only through an audited correction;
- at most one open enrollment per member and program.

Application validation alone is not enough. Races, bugs, scripts and manual SQL bypass it.

## Decision

- **Prisma 7** (`prisma-client` generator, output `apps/api/src/generated/prisma`, driver adapter
  `@prisma/adapter-pg`) owns the schema (`apps/api/prisma/schema.prisma`) and generates the
  typed client.
- Invariants Prisma cannot model live in **hand-written SQL migrations**:
  `prisma/migrations/<ts>_integrity_constraints/migration.sql` and later additions. That SQL holds
  CHECK constraints, partial unique indexes, an exclusion constraint (btree_gist), immutability
  and state-machine triggers, deferred double-entry balance triggers, and a balances view. Each
  one is catalogued with its rationale in [docs/database.md](../database.md).
- Triggers raise SQLSTATE `23001` (`restrict_violation`, or `23514` `check_violation` for the
  ledger). The API maps them to **HTTP 409 `INVARIANT_VIOLATION`**. Services still validate first
  and return friendly domain errors. The database is the last line of defence.
- Migrations are created with `prisma migrate diff … --script` into a new folder, reviewed, and
  applied **only** with `prisma migrate deploy`. `migrate dev` (interactive, can reset data) and
  `db push` (no migration history, drops hand-written SQL) are never used against shared
  databases.
- Raw SQL (`$queryRaw` with tagged-template parameters) is allowed where Prisma is a poor fit:
  closure-table moves, `FOR UPDATE [SKIP LOCKED]`, aggregates. It is never built by string
  concatenation.

## Consequences

- Invariants hold no matter which code path, job or operator writes the data.
- Integration tests run against real PostgreSQL (`referral_test`), because SQLite or mocks would
  not exercise triggers and constraints.
- Prisma's schema does not show the SQL-level rules. `schema.prisma` comments point to them, and
  `docs/database.md` is the catalogue to keep in sync.
- Changing a guarded table may require a migration that replaces a trigger function. Tests must
  cover each guard.

## Alternatives considered

- **Application-only validation:** rejected. It does not survive concurrency, manual fixes or
  future code paths.
- **A query builder (Kysely/Drizzle) without an ORM:** viable, but Prisma's generated types,
  migration history and tooling were preferred. Raw SQL remains available for the cases above.
- **Stored procedures for all writes:** rejected. It is too much logic in PL/pgSQL and harder to
  test and evolve. Triggers are limited to guarding invariants, not running business workflows.
