import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { AppConfig } from '../../config/app-config';
import { Prisma, PrismaClient } from '../../generated/prisma/client';
import { inspectDbError } from '../errors/db-error';

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
    super({ adapter: new PrismaPg({ connectionString: config.database.url, max: config.database.poolMax }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
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
