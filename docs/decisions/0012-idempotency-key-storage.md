# ADR-0012: Idempotency keys stored in PostgreSQL

- **Status:** Accepted
- **Date:** 2026-10-10

## Context

Financial mutations (approve, reject, reverse, bulk approve, event reversal, recording a sale,
publishing a policy, correcting a sponsor) are triggered from browsers on unreliable networks.
Double clicks, client retries after a timeout and proxy retries must not apply a decision twice,
and a retry must get **the same answer** as the original request, including per-item results of a
bulk approval. Requirements:

- keys survive API restarts and are shared by every API replica;
- a key reused for a different request is detected, not silently replayed;
- a key cannot be used to read someone else's response;
- the money guarantees (one posting per reward, one calculation per sale) must not depend on the
  client sending a key at all.

## Decision

1. **Generic HTTP idempotency in a PostgreSQL table** `idempotency_keys`:
   PK `(actor_user_id, key)`, `route` (method + route pattern), `request_hash` (SHA-256 of the
   canonical `{ method, route, params, query, body }`), `status` (`IN_PROGRESS` | `COMPLETED`),
   `response_status`, `response_body` (JSON, bigint as strings), `created_at`, `expires_at`
   (24 h). CHECKs: COMPLETED ⇒ response stored; hash is 64 hex.
2. **Atomic claim:** one `INSERT … ON CONFLICT (actor_user_id, key) DO UPDATE … WHERE` the existing
   row has expired, **or** is an `IN_PROGRESS` row older than 5 minutes for the same route and hash
   (a crashed request), `RETURNING`. Otherwise the existing row decides:
   - same route and hash, COMPLETED → replay the stored status and body with
     `Idempotent-Replayed: true`, without running the handler;
   - same route and hash, still IN_PROGRESS → `409 CONFLICT` with `details.retryable`;
   - different route or hash → `409 IDEMPOTENCY_CONFLICT`.
3. **Only successes are stored.** A failed handler releases the key, so the client can fix the
   problem and retry with the same key.
4. **Opt-in per route** with `@Idempotent({ required })` (global `IdempotencyInterceptor`;
   `IdempotencyService` for non-HTTP callers). Required on reward approve/reject/reverse, bulk
   approve and event reversal; optional on sale recording, policy publish/retire and sponsor
   correction. The header is `Idempotency-Key`, 8–128 chars of `[A-Za-z0-9_-:.]`.
5. **Keys are scoped per actor** and purged hourly by `idempotency-keys-cleanup`; rows cascade
   with their user.
6. **Domain idempotency is independent and permanent**, and is what actually protects money:
   - sales: unique `(offering_id, external_id, revision)` plus `request_hash` stored on the event
     (replay returns the existing event; different facts → `409 IDEMPOTENCY_CONFLICT`), which also
     covers API clients that never send a header;
   - one calculation per event (`reward_calculations.event_id` unique), one reward per level and
     recipient;
   - one posting and one reversal per reward (`reward-posting:<id>`, `reward-reversal:<id>`
     unique keys, enforced shapes), plus the reward state machine.

## Consequences

- Retries are safe and return the original response; concurrent duplicates get a retryable 409
  instead of a second execution.
- No Redis dependency for correctness: a Redis outage or eviction cannot cause a double decision.
  Keys are queryable for support ("was this approval retried?").
- Two extra small writes per idempotent request (claim + complete/release) and a 24 h table that
  the hourly job keeps small.
- **The key row is not part of the business transaction** (it is claimed before and completed
  after the handler). If the process dies after the business commit but before `complete`, the key
  stays IN_PROGRESS: retries within 5 minutes get `409 CONFLICT` (retryable); a later retry re-runs
  the handler, which then hits the domain guards (for example `409 INVALID_STATE_TRANSITION`,
  because the reward is already POSTED) instead of acting twice. The client may see a different
  response than the lost original, but money is never double-counted.
- Stored response bodies contain only what the actor already received, and only for 24 h.
- Keys are per actor: two admins cannot share one key (intended; each decision has one accountable
  actor).

## Alternatives considered

- **Redis `SET NX` with a TTL:** fast, but volatile (eviction, failover, flush) and outside the
  database transaction model; a lost key turns a retry into a second execution unless the domain
  catches it.
- **Store the key inside each business transaction:** atomic with the business write, but every
  service would need HTTP concerns (key, response body) in its signature, and the stored response
  is only known after the transaction commits.
- **Domain idempotency only:** prevents double effects but cannot replay the original response
  (bulk results, created ids), and turns innocent retries into confusing 409s.
