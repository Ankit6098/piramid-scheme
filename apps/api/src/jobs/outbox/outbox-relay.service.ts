import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context';
import { OUTBOX_TERMINAL_SCRUB_KEYS } from '../../common/outbox/outbox.topics';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { JOBS_OPTIONS, type JobsModuleOptions } from '../jobs.options';
import { computeBackoffMs } from './backoff';
import { OutboxHandlerRegistry, PermanentOutboxError, type OutboxMessageView } from './outbox-handler.registry';

export const OUTBOX_BATCH_SIZE = 50;
export const OUTBOX_POLL_INTERVAL_MS = 2_000;
/** PROCESSING rows locked longer than this (crashed worker) are reclaimed. */
export const OUTBOX_STALE_LOCK_SECONDS = 300;

interface ClaimedRow {
  id: string;
  topic: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
}

export interface RelayRunResult {
  claimed: number;
  sent: number;
  failed: number;
  dead: number;
  /** Claims taken over by another relay (stale-lock reclaim) before this one finished: result discarded. */
  lost: number;
}

type Outcome = 'sent' | 'failed' | 'dead' | 'lost';

/** String leaves of a payload (≥ 6 chars) — redacted from error messages before they are stored. */
function payloadStrings(payload: unknown, out: string[] = []): string[] {
  if (typeof payload === 'string') {
    if (payload.length >= 6) out.push(payload);
  } else if (Array.isArray(payload)) {
    for (const v of payload) payloadStrings(v, out);
  } else if (payload !== null && typeof payload === 'object') {
    for (const v of Object.values(payload as Record<string, unknown>)) payloadStrings(v, out);
  }
  return out;
}

/**
 * `last_error` text: error name + message, with every payload string value redacted (it must never
 * contain the payload, e.g. a ciphertext or an address), capped at 2000 chars.
 */
export function outboxErrorMessage(err: unknown, payload: unknown): string {
  let msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  for (const value of payloadStrings(payload).sort((a, b) => b.length - a.length)) {
    msg = msg.split(value).join('[redacted]');
  }
  return msg.slice(0, 2000);
}

/**
 * Delivers outbox_messages. Every 2 s (immediately again while batches are full) it claims up to 50
 * due rows with `FOR UPDATE SKIP LOCKED` (safe with several workers), marks them PROCESSING
 * (attempts + 1), dispatches each to its topic handler outside any transaction, then marks SENT, or
 * FAILED with exponential backoff + jitter (`available_at`), or DEAD after `max_attempts`
 * (or on PermanentOutboxError / missing handler at the last attempt). The UPDATE that marks a row SENT
 * or DEAD also removes `codeCiphertext` (+ the handler's `scrubKeys`) from its payload.
 *
 * Claim ownership: the `attempts` value returned by the claim is the claim token. Right before a row
 * is dispatched its `locked_at` is refreshed (rows queued behind slow ones in the same batch never
 * look stale), and every later UPDATE of the row requires `status = PROCESSING AND attempts = token`.
 * If another relay reclaimed the row after OUTBOX_STALE_LOCK_SECONDS, this relay's late result is
 * discarded (`lost`) instead of overwriting the other relay's SENT with FAILED (and re-sending).
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelay.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  private stopped = true;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: OutboxHandlerRegistry,
    @Inject(JOBS_OPTIONS) private readonly options: JobsModuleOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.processing) return;
    this.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.logger.log(`Outbox relay started (topics: ${this.registry.topics().join(', ') || 'none'})`);
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.running) await this.running.catch(() => undefined);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.runOnce()
        .then((r) => this.schedule(r.claimed >= OUTBOX_BATCH_SIZE ? 0 : OUTBOX_POLL_INTERVAL_MS))
        .catch((err: unknown) => {
          this.logger.error({ err }, 'Outbox relay iteration failed');
          this.schedule(OUTBOX_POLL_INTERVAL_MS * 5);
        })
        .finally(() => {
          this.running = null;
        });
    }, delayMs);
  }

  /** Claims and processes one batch. Public for tests and manual draining. */
  async runOnce(batchSize = OUTBOX_BATCH_SIZE): Promise<RelayRunResult> {
    const rows = await this.claim(batchSize);
    const result: RelayRunResult = { claimed: rows.length, sent: 0, failed: 0, dead: 0, lost: 0 };
    for (const row of rows) {
      const outcome = await RequestContext.run({ requestId: `outbox:${row.id}` }, () => this.process(row));
      result[outcome] += 1;
    }
    return result;
  }

  /** Processes until no due message is left (tests). */
  async drain(maxBatches = 20): Promise<RelayRunResult> {
    const total: RelayRunResult = { claimed: 0, sent: 0, failed: 0, dead: 0, lost: 0 };
    for (let i = 0; i < maxBatches; i++) {
      const r = await this.runOnce();
      total.claimed += r.claimed;
      total.sent += r.sent;
      total.failed += r.failed;
      total.dead += r.dead;
      total.lost += r.lost;
      if (r.claimed === 0) break;
    }
    return total;
  }

  private async claim(batchSize: number): Promise<ClaimedRow[]> {
    return this.prisma.$queryRaw<ClaimedRow[]>`
      UPDATE "outbox_messages" AS o
         SET "status" = 'PROCESSING', "locked_at" = now(), "attempts" = o."attempts" + 1
       WHERE o."id" IN (
         SELECT "id" FROM "outbox_messages"
          WHERE ("status" IN ('PENDING', 'FAILED') AND "available_at" <= now())
             OR ("status" = 'PROCESSING' AND "locked_at" < now() - make_interval(secs => ${OUTBOX_STALE_LOCK_SECONDS}))
          ORDER BY "available_at"
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING o."id", o."topic", o."payload", o."attempts", o."max_attempts" AS "maxAttempts", o."created_at" AS "createdAt"`;
  }

  private async process(row: ClaimedRow): Promise<Outcome> {
    // Still ours? (A slow batch may have been reclaimed as stale by another relay.) Refresh the lock
    // so the stale timeout counts from this row's dispatch, not from the batch claim.
    if (!(await this.refreshClaim(row))) return this.lost(row, 'before dispatch');
    const registration = this.registry.get(row.topic);
    const message: OutboxMessageView = { ...row };
    try {
      if (!registration) throw new Error(`No outbox handler registered for topic "${row.topic}"`);
      await registration.handle(message as OutboxMessageView<never>);
      if (!(await this.finish(row, 'SENT', null, registration.scrubKeys))) return this.lost(row, 'after delivery');
      return 'sent';
    } catch (err) {
      const permanent = err instanceof PermanentOutboxError;
      const dead = permanent || row.attempts >= row.maxAttempts;
      const lastError = outboxErrorMessage(err, row.payload);
      if (dead) {
        if (!(await this.finish(row, 'DEAD', lastError, registration?.scrubKeys))) return this.lost(row, 'after a final failure');
        this.logger.error({ outboxId: row.id, topic: row.topic, attempts: row.attempts, error: lastError }, 'Outbox message is DEAD');
        return 'dead';
      }
      const delay = computeBackoffMs(row.attempts);
      const { count } = await this.prisma.outboxMessage.updateMany({
        where: { id: row.id, status: 'PROCESSING', attempts: row.attempts },
        data: { status: 'FAILED', lockedAt: null, lastError, availableAt: new Date(Date.now() + delay) },
      });
      if (count === 0) return this.lost(row, 'after a failed delivery');
      this.logger.warn({ outboxId: row.id, topic: row.topic, attempts: row.attempts, retryInMs: delay, error: lastError }, 'Outbox delivery failed; will retry');
      return 'failed';
    }
  }

  /** Renews `locked_at` of a row this relay still owns (claim token = attempts). */
  private async refreshClaim(row: ClaimedRow): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      UPDATE "outbox_messages" SET "locked_at" = now()
       WHERE "id" = ${row.id}::uuid AND "status" = 'PROCESSING' AND "attempts" = ${row.attempts}`;
    return n === 1;
  }

  private lost(row: ClaimedRow, when: string): 'lost' {
    this.logger.warn({ outboxId: row.id, topic: row.topic, attempts: row.attempts }, `Outbox claim taken over by another relay ${when}; result discarded`);
    return 'lost';
  }

  /**
   * Marks a row this relay still owns SENT/DEAD and scrubs secret payload keys in the same UPDATE.
   * False when the claim was lost (another relay reclaimed the row).
   */
  private async finish(row: ClaimedRow, status: 'SENT' | 'DEAD', lastError: string | null, extraKeys: readonly string[] = []): Promise<boolean> {
    const keys = [...new Set([...OUTBOX_TERMINAL_SCRUB_KEYS, ...extraKeys])];
    const n = await this.prisma.$executeRaw`
      UPDATE "outbox_messages"
         SET "status" = ${status}::"OutboxStatus",
             "processed_at" = now(),
             "locked_at" = NULL,
             "last_error" = ${lastError},
             "payload" = "payload" - ARRAY[${Prisma.join(keys)}]::text[]
       WHERE "id" = ${row.id}::uuid AND "status" = 'PROCESSING' AND "attempts" = ${row.attempts}`;
    return n === 1;
  }
}
