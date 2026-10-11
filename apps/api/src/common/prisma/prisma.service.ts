import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { AppConfig } from '../../config/app-config';
import { Prisma, PrismaClient } from '../../generated/prisma/client';
import { inspectDbError } from '../errors/db-error';
import { pgPoolConfig } from './create-client';

/** `current_setting('TimeZone')` values that mean UTC. */
const UTC_ZONE_NAMES = new Set(['UTC', 'Etc/UTC', 'UCT', 'Etc/UCT', 'Universal', 'Etc/Universal', 'Zulu', 'Etc/Zulu']);

/** Interactive-transaction client. Every multi-row write receives one of these. */
export type Tx = Prisma.TransactionClient;
/**
 * Anything that can run queries: the root client (PrismaService is structurally assignable) or a
 * transaction client. Use for read helpers that may run inside or outside a transaction.
 */
export type Db = Prisma.TransactionClient;

export interface TransactionOptions {
  isolationLevel?: Prisma.TransactionIsolationLevel;
  /** Max time (ms) the transaction may run. Default 15 000. */
  timeout?: number;
  /** Max time (ms) to wait for a connection. Default 5 000. */
  maxWait?: number;
  /**
   * Retries on serialization failures / deadlocks (SQLSTATE 40001/40P01, Prisma P2034). Default 0.
   * Only use with idempotent `fn`s — the whole callback is re-run.
   */
  retries?: number;
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: AppConfig) {
    super({
      adapter: new PrismaPg(
        pgPoolConfig(config.database.url, config.database.poolMax, {
          connectTimeoutMs: config.database.connectTimeoutMs,
          statementTimeoutMs: config.database.statementTimeoutMs,
          lockTimeoutMs: config.database.lockTimeoutMs,
        }),
      ),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    await this.assertUtcSession();
  }

  /**
   * Fails fast when DB sessions are not in UTC (pinned with `-c TimeZone=UTC`; a connection-string
   * `options` parameter would override it): Date parameters are sent as UTC wall-clock text, so any
   * other session time zone shifts every timestamp the API writes or compares. An unreachable
   * database is only logged here — requests then fail with 503 until it is back.
   */
  async assertUtcSession(): Promise<void> {
    let tz: string | undefined;
    try {
      const rows = await this.$queryRaw<Array<{ tz: string }>>`SELECT current_setting('TimeZone') AS "tz"`;
      tz = rows[0]?.tz;
    } catch (err) {
      this.logger.warn(`Could not verify the database session time zone at startup: ${(err as Error).message}`);
      return;
    }
    if (!tz || !UTC_ZONE_NAMES.has(tz)) {
      throw new Error(`Database sessions must use TimeZone=UTC (got "${tz ?? 'unknown'}"); remove any "options" override from DATABASE_URL`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Runs `fn` in an interactive transaction. Audit + outbox writes belong inside `fn`; never send
   * email or call external services from inside it.
   *
   * @example
   * await this.prisma.runInTransaction(async (tx) => {
   *   const p = await tx.program.update(...);
   *   await this.audit.record(tx, { action: 'program.publish', resourceType: 'program', resourceId: p.id });
   * }, { isolationLevel: 'Serializable', retries: 2 });
   */
  async runInTransaction<T>(fn: (tx: Tx) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    const { retries = 0, ...txOptions } = options;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.$transaction(fn, {
          timeout: txOptions.timeout ?? 15_000,
          maxWait: txOptions.maxWait ?? 5_000,
          ...(txOptions.isolationLevel ? { isolationLevel: txOptions.isolationLevel } : {}),
        });
      } catch (err) {
        const info = inspectDbError(err);
        const retryable =
          info && (info.prismaCode === 'P2034' || info.sqlState === '40001' || info.sqlState === '40P01');
        if (!retryable || attempt >= retries) throw err;
        this.logger.warn(`Retrying transaction after write conflict (attempt ${attempt + 1}/${retries})`);
        await new Promise((r) => setTimeout(r, 20 * 2 ** attempt + Math.random() * 20));
      }
    }
  }
}

export { Prisma };
export { createPrismaClient } from './create-client';
