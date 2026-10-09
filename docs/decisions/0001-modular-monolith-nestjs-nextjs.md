# ADR-0001: Modular monolith — NestJS API + Next.js web in one pnpm workspace

- **Status:** Accepted
- **Date:** 2026-10-09

## Context

The platform has a dozen tightly related domains (auth, programs, policies, enrollments, referral
tree, events, the reward engine, the ledger, reconciliation, audit). Most use cases touch several
of them **in one database transaction**. For example, processing an event locks the event, reads
the referral closure, writes the calculation, the rewards and the ledger entries, adds an audit row
and an outbox message. The team is small, and correctness and auditability matter more than
scaling domains independently.

## Decision

- One repository with **pnpm workspaces**: `apps/api` (NestJS 11 on Express 5), `apps/web`
  (Next.js 16 App Router), `packages/shared` (`@app/shared`: Zod contracts, enums, permission keys,
  error codes, amount formatting).
- The API is a **modular monolith**: one deployable, one PostgreSQL database, with modules in
  `apps/api/src/modules/<module>`. Each module has a controller (HTTP only), a service (use
  cases and transactions), pure `domain/` functions (unit-tested), and an optional repository.
  Cross-cutting concerns (auth guards, errors, audit, outbox, pagination, money) live in
  `src/common`.
- **Two process roles from the same build:** `dist/main.js` (HTTP) and `dist/worker.js` (outbox
  relay, BullMQ processors, schedulers). They share the code and the Docker image.
- The web app is a separate Next.js server. Browsers call the API on the **same origin** (see
  ADR-0008). Server components call it directly at `API_INTERNAL_URL`.
- Shared contracts in `@app/shared` are the single source of request and response shapes for
  both apps.

## Consequences

- Multi-domain invariants are enforced with ordinary ACID transactions, with no sagas and no
  distributed consistency.
- One build, one image per app, one migration stream. The architecture is simple to run
  (docker-compose) and simple to reason about.
- Module boundaries are enforced by convention and review, not by the network. Services must
  not reach into another module's tables when that module offers a service method.
- The API scales horizontally as one unit (stateless HTTP, sessions in PostgreSQL). Hot spots
  are addressed inside the monolith (indexes, caching, read replicas) before anything is split.
- If a module is ever extracted, its contracts in `@app/shared` and its outbox topics are the
  seams.

## Alternatives considered

- **Microservices per domain:** rejected. Cross-domain transactions (event → rewards → ledger)
  would need sagas or two-phase commit. The operational cost is high for the team size.
- **Next.js only (route handlers as the API):** rejected. A long-running worker, BullMQ, a
  rich DI/guard model and an independent OpenAPI surface are easier in NestJS. It also keeps
  business logic out of the rendering tier.
- **Separate repositories:** rejected. Shared contracts would need publishing and version skew
  between web and API would become possible.
