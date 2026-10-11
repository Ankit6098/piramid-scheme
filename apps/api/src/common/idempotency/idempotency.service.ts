import { Injectable, Logger } from '@nestjs/common';
import { ErrorCode } from '@app/shared';
import { Prisma } from '../../generated/prisma/client';
import { AppError, conflict } from '../errors/app-error';
import { toJsonValue } from '../http/json-safe';
import { PrismaService, type Db } from '../prisma/prisma.service';

/** Keys are remembered for 24 h (then purged by the `idempotency-keys-cleanup` job). */
export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;
/** An IN_PROGRESS key older than this (crashed request) may be taken over by a retry with the same payload. */
export const IDEMPOTENCY_STALE_IN_PROGRESS_MS = 5 * 60_000;

export interface IdempotencyScope {
  /** The authenticated actor — keys are scoped per user. */
  actorUserId: string;
  /** Client-supplied `Idempotency-Key` (8–128 chars, see parseIdempotencyKey). */
  key: string;
}

export interface IdempotencyBeginInput extends IdempotencyScope {
  /** Operation identifier, e.g. 'POST /api/v1/admin/rewards/:id/approve' (≤ 128 chars). */
  route: string;
  /** 64 lower-case hex chars: `computeRequestHash({ method, route, params, query, body })`. */
  requestHash: string;
}

export type IdempotencyBeginResult =
  | { state: 'new' }
  | { state: 'replay'; status: number; body: unknown };

export interface IdempotencyCompleteInput extends IdempotencyScope {
  /** HTTP status of the stored response. */
  status: number;
  /** JSON-compatible response body (bigint is converted to strings). */
  body: unknown;
}

/**
 * Persistent Idempotency-Key handling for financial mutations (business rules §9), backed by
 * `idempotency_keys` (PK actor_user_id + key):
 *
 *   const r = await idem.begin({ actorUserId, key, route, requestHash });
 *   if (r.state === 'replay') return r.body;            // same key + same request → stored response
 *   let body; try { body = await doWork(); }
 *   catch (e) { await idem.release({ actorUserId, key }); throw e; }   // failed work can be retried
 *   await idem.completeBestEffort({ actorUserId, key, status: 200, body }); // never release after success
 *
 * - same key, different route or request hash → 409 IDEMPOTENCY_CONFLICT;
 * - same key while the first request is still running → 409 CONFLICT (`details.retryable`);
 * - expired keys (24 h) and IN_PROGRESS keys abandoned for > 5 min are reused.
 * HTTP routes should simply use `@Idempotent()` (IdempotencyInterceptor) instead of calling this.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  async begin(input: IdempotencyBeginInput, db: Db = this.prisma): Promise<IdempotencyBeginResult> {
    if (!/^[0-9a-f]{64}$/.test(input.requestHash)) throw new Error('IdempotencyService.begin: requestHash must be 64 lower-case hex chars');
    const route = input.route.slice(0, 128);
    const ttlSeconds = Math.round(IDEMPOTENCY_TTL_MS / 1000);
    const staleSeconds = Math.round(IDEMPOTENCY_STALE_IN_PROGRESS_MS / 1000);
    const claimed = await db.$queryRaw<Array<{ claimed: boolean }>>`
      INSERT INTO "idempotency_keys" ("actor_user_id", "key", "route", "request_hash", "status", "created_at", "expires_at")
      VALUES (${input.actorUserId}::uuid, ${input.key}, ${route}, ${input.requestHash}, 'IN_PROGRESS', now(),
              now() + make_interval(secs => ${ttlSeconds}))
      ON CONFLICT ("actor_user_id", "key") DO UPDATE
         SET "route" = EXCLUDED."route", "request_hash" = EXCLUDED."request_hash", "status" = 'IN_PROGRESS',
             "response_status" = NULL, "response_body" = NULL, "created_at" = now(), "expires_at" = EXCLUDED."expires_at"
       WHERE "idempotency_keys"."expires_at" <= now()
          OR ("idempotency_keys"."status" = 'IN_PROGRESS'
              AND "idempotency_keys"."created_at" < now() - make_interval(secs => ${staleSeconds})
              AND "idempotency_keys"."request_hash" = EXCLUDED."request_hash"
              AND "idempotency_keys"."route" = EXCLUDED."route")
      RETURNING true AS "claimed"`;
    if (claimed.length === 1) return { state: 'new' };

    const row = await db.idempotencyKey.findUnique({
      where: { actorUserId_key: { actorUserId: input.actorUserId, key: input.key } },
      select: { route: true, requestHash: true, status: true, responseStatus: true, responseBody: true },
    });
    if (!row) throw conflict('The Idempotency-Key is being processed. Please retry', { retryable: true });
    if (row.route !== route || row.requestHash !== input.requestHash) {
      throw new AppError(
        ErrorCode.IdempotencyConflict,
        'This Idempotency-Key was already used for a different request',
        409,
      );
    }
    if (row.status === 'IN_PROGRESS' || row.responseStatus === null) {
      throw conflict('A request with this Idempotency-Key is still being processed', { retryable: true });
    }
    return { state: 'replay', status: row.responseStatus, body: row.responseBody };
  }

  /** Stores the response of a successful request (status COMPLETED). */
  async complete(input: IdempotencyCompleteInput, db: Db = this.prisma): Promise<void> {
    const json = toJsonValue(input.body);
    const res = await db.idempotencyKey.updateMany({
      where: { actorUserId: input.actorUserId, key: input.key, status: 'IN_PROGRESS' },
      data: {
        status: 'COMPLETED',
        responseStatus: input.status,
        responseBody: json === null ? Prisma.JsonNull : (json as Prisma.InputJsonValue),
      },
    });
    if (res.count !== 1) this.logger.warn({ key: input.key.slice(0, 8) }, 'Idempotency key vanished before completion');
  }

  /**
   * `complete()` after the work has committed: retried once, never throws. If the response cannot be
   * stored the key stays IN_PROGRESS — a retry then gets 409 CONFLICT (and, after
   * IDEMPOTENCY_STALE_IN_PROGRESS_MS, may take the key over) instead of re-running committed work
   * right away. Returns whether the response was stored.
   */
  async completeBestEffort(input: IdempotencyCompleteInput, db: Db = this.prisma): Promise<boolean> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.complete(input, db);
        return true;
      } catch (err) {
        if (attempt === 2) {
          this.logger.error(
            { key: input.key.slice(0, 8), err: err instanceof Error ? err.message : String(err) },
            'Could not store the idempotent response; the key stays IN_PROGRESS',
          );
        }
      }
    }
    return false;
  }

  /** Forgets an IN_PROGRESS key after a failed request, so the client may retry with the same key. */
  async release(input: IdempotencyScope, db: Db = this.prisma): Promise<void> {
    await db.idempotencyKey.deleteMany({ where: { actorUserId: input.actorUserId, key: input.key, status: 'IN_PROGRESS' } });
  }

  /**
   * begin → fn → complete (or release on error) for non-HTTP callers. Returns the stored response on
   * a replay.
   */
  async execute<T>(
    input: IdempotencyBeginInput,
    fn: () => Promise<T>,
    status = 200,
  ): Promise<{ replayed: boolean; status: number; body: T | unknown }> {
    const begun = await this.begin(input);
    if (begun.state === 'replay') return { replayed: true, status: begun.status, body: begun.body };
    let body: T;
    try {
      body = await fn();
    } catch (err) {
      // Only a failed `fn` releases the key: its work did not happen, so it may be retried.
      await this.release(input).catch(() => undefined);
      throw err;
    }
    await this.completeBestEffort({ actorUserId: input.actorUserId, key: input.key, status, body });
    return { replayed: false, status, body };
  }

  /** Deletes expired keys; returns the count (scheduled hourly by the worker). */
  async purgeExpired(now: Date = new Date(), db: Db = this.prisma): Promise<number> {
    const res = await db.idempotencyKey.deleteMany({ where: { expiresAt: { lte: now } } });
    return res.count;
  }
}
