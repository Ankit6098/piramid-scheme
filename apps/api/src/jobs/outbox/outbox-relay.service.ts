import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { RequestContext } from '../../common/context/request-context';
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
}

function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return msg.slice(0, 2000);
}

/**
 * Delivers outbox_messages. Every 2 s (immediately again while batches are full) it claims up to 50
 * due rows with `FOR UPDATE SKIP LOCKED` (safe with several workers), marks them PROCESSING
 * (attempts + 1), dispatches each to its topic handler outside any transaction, then marks SENT, or
 * FAILED with exponential backoff + jitter (`available_at`), or DEAD after `max_attempts`
 * (or on PermanentOutboxError / missing handler at the last attempt).
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
    const result: RelayRunResult = { claimed: rows.length, sent: 0, failed: 0, dead: 0 };
    for (const row of rows) {
      const outcome = await RequestContext.run({ requestId: `outbox:${row.id}` }, () => this.process(row));
      result[outcome] += 1;
    }
    return result;
  }

  /** Processes until no due message is left (tests). */
  async drain(maxBatches = 20): Promise<RelayRunResult> {
    const total: RelayRunResult = { claimed: 0, sent: 0, failed: 0, dead: 0 };
    for (let i = 0; i < maxBatches; i++) {
      const r = await this.runOnce();
      total.claimed += r.claimed;
      total.sent += r.sent;
      total.failed += r.failed;
      total.dead += r.dead;
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

  private async process(row: ClaimedRow): Promise<'sent' | 'failed' | 'dead'> {
    const registration = this.registry.get(row.topic);
    const message: OutboxMessageView = { ...row };
    try {
      if (!registration) throw new Error(`No outbox handler registered for topic "${row.topic}"`);
      await registration.handle(message as OutboxMessageView<never>);
      await this.prisma.outboxMessage.updateMany({
        where: { id: row.id, status: 'PROCESSING' },
        data: {
          status: 'SENT',
          processedAt: new Date(),
          lockedAt: null,
          lastError: null,
          ...this.scrubbed(registration.scrub, row.payload),
        },
      });
      return 'sent';
    } catch (err) {
      const permanent = err instanceof PermanentOutboxError;
      const dead = permanent || row.attempts >= row.maxAttempts;
      const lastError = errorMessage(err);
      if (dead) {
        await this.prisma.outboxMessage.updateMany({
          where: { id: row.id, status: 'PROCESSING' },
          data: {
            status: 'DEAD',
            processedAt: new Date(),
            lockedAt: null,
            lastError,
            ...this.scrubbed(registration?.scrub, row.payload),
          },
        });
        this.logger.error({ outboxId: row.id, topic: row.topic, attempts: row.attempts, error: lastError }, 'Outbox message is DEAD');
        return 'dead';
      }
      const delay = computeBackoffMs(row.attempts);
      await this.prisma.outboxMessage.updateMany({
        where: { id: row.id, status: 'PROCESSING' },
        data: { status: 'FAILED', lockedAt: null, lastError, availableAt: new Date(Date.now() + delay) },
      });
      this.logger.warn({ outboxId: row.id, topic: row.topic, attempts: row.attempts, retryInMs: delay, error: lastError }, 'Outbox delivery failed; will retry');
      return 'failed';
    }
  }

  private scrubbed(scrub: ((p: never) => unknown) | undefined, payload: unknown): { payload?: Prisma.InputJsonValue } {
    if (!scrub) return {};
    try {
      return { payload: scrub(payload as never) as Prisma.InputJsonValue };
    } catch {
      return {};
    }
  }
}
