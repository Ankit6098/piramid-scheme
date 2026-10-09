# ADR-0006: Transactional outbox + BullMQ worker

- **Status:** Accepted
- **Date:** 2026-10-09

## Context

Business changes trigger side effects: OTP and notice emails, in-app notifications, and later
webhooks. Sending email inside a database transaction has two failure modes. It can send for a
transaction that later rolls back, and it holds locks while waiting on SMTP. Sending after commit
can silently lose the message if the process dies in between. Recurring jobs (program
SCHEDULED→ACTIVE at `startsAt`, ACTIVE→COMPLETED at `endsAt`, enrollment expiry, outbox cleanup)
must run exactly once per occurrence, even with several worker replicas.

## Decision

- **Outbox:** inside the same `prisma.$transaction` as the business change, services call
  `OutboxService.enqueue(tx, { topic, payload, dedupeKey? })`. This inserts a row into
  `outbox_messages`, so the message exists if and only if the change committed. `dedupe_key`
  (unique) makes enqueueing idempotent.
- **Relay (worker process):** every ~2 s it claims up to 50 due rows. The rows are `PENDING`, or
  `FAILED` with `available_at ≤ now()`, or `PROCESSING` with a lock older than 5 min (reclaimed
  after a crash). Claiming uses `FOR UPDATE SKIP LOCKED` and marks the rows `PROCESSING`
  (`attempts + 1`). The relay dispatches each row to its topic handler **outside** any
  transaction, then marks it `SENT`. On failure it marks the row `FAILED` with exponential
  backoff + jitter, or `DEAD` after `max_attempts` (default 8) or on a permanent error. SKIP
  LOCKED makes several worker replicas safe.
- **Handlers are idempotent** (at-least-once delivery). Email handlers render templates from the
  payload. Payloads never contain secrets except the one-time code that the email must carry. That
  code is redacted from the payload once the message is `SENT` or `DEAD`, and raw codes are never
  logged. `SENT` rows are purged after 14 days, while `DEAD` rows are kept for inspection.
- **BullMQ (Redis):** job schedulers (`upsertJobScheduler`, keyed by job name) drive recurring
  jobs, so several workers do not duplicate a schedule. Each fired job is processed by one
  worker. Redis is a delivery mechanism. PostgreSQL stays the source of truth.
- **Process roles:** `dist/worker.js` runs the relay, processors and schedulers. The HTTP API does
  not, unless `RUN_WORKER_IN_API=true` (development convenience).

## Consequences

- No lost or phantom emails relative to committed state, and no SMTP latency inside transactions.
- Delivery is asynchronous. The UI says "we've sent you a code", and e2e tests poll Mailpit
  (`tests/e2e/utils/mailpit.ts`).
- `DEAD` rows need operator attention. They are visible in the database and should be surfaced on
  the admin overview. A daily cleanup job prunes old `SENT` rows.
- Redis loss does not lose business messages. Outbox rows are re-claimed from PostgreSQL, and
  schedulers are re-installed at worker start.

## Alternatives considered

- **Send directly from request handlers:** rejected because of the failure modes above.
- **BullMQ jobs enqueued in the request after commit:** Redis enqueue is not atomic with the DB
  commit, so messages can be lost.
- **Logical decoding / Debezium CDC:** robust, but heavy infrastructure for the current volume.
- **pg-boss (PostgreSQL-only queue):** viable. BullMQ was preferred for its scheduler API, its
  tooling, and because Redis is already used for shared rate-limit counters.
