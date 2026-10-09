import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';
import { AppConfig } from '../../config/app-config';

/** Parses redis[s]://[user:pass@]host[:port][/db] into ioredis options. */
export function redisOptionsFromUrl(redisUrl: string): RedisOptions {
  const u = new URL(redisUrl);
  const db = u.pathname && u.pathname !== '/' ? Number(u.pathname.slice(1)) : undefined;
  return {
    host: u.hostname || 'localhost',
    port: u.port ? Number(u.port) : 6379,
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(db !== undefined && Number.isInteger(db) ? { db } : {}),
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

/** Options suitable for BullMQ connections (workers need `maxRetriesPerRequest: null`). */
export function bullConnectionOptions(redisUrl: string): RedisOptions {
  return { ...redisOptionsFromUrl(redisUrl), maxRetriesPerRequest: null, enableReadyCheck: true };
}

export function createRedis(redisUrl: string, options: RedisOptions = {}): Redis {
  return new Redis(redisUrl, options);
}

/**
 * Shared, lazily-connected Redis client for request-path use (readiness check, rate-limit storage).
 * BullMQ creates its own connections (see jobs/).
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;

  constructor(private readonly config: AppConfig) {}

  get redis(): Redis {
    if (!this.client) {
      this.client = createRedis(this.config.redis.url, {
        lazyConnect: true,
        maxRetriesPerRequest: 2,
        connectTimeout: 2_000,
        enableOfflineQueue: true,
      });
      this.client.on('error', (err: Error) => this.logger.warn(`Redis error: ${err.message}`));
    }
    return this.client;
  }

  /** PING with a timeout. Resolves true/false, never throws. */
  async ping(timeoutMs = 1_000): Promise<boolean> {
    try {
      const result = await Promise.race([
        this.redis.ping(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs).unref()),
      ]);
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.client) return;
    const c = this.client;
    this.client = null;
    try {
      await c.quit();
    } catch {
      c.disconnect();
    }
  }
}
