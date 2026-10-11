import { Logger } from '@nestjs/common';
import { ThrottlerStorageService, type ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';

interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * Fixed-window counter + block key, atomically in Lua.
 * KEYS[1] hits key, KEYS[2] block key; ARGV ttlMs, limit, blockMs.
 * Returns { hits, hitsPttl, blocked(0|1), blockPttl }.
 */
const SCRIPT = `
local blockPttl = redis.call('PTTL', KEYS[2])
if blockPttl > 0 then
  local hits = tonumber(redis.call('GET', KEYS[1]) or '0')
  return { hits, redis.call('PTTL', KEYS[1]), 1, blockPttl }
end
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local pttl = redis.call('PTTL', KEYS[1])
if pttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); pttl = tonumber(ARGV[1]) end
if hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  return { hits, pttl, 1, tonumber(ARGV[3]) }
end
return { hits, pttl, 0, 0 }
`;

export interface RedisThrottlerStorageOptions {
  /** Max wait for Redis per request before falling back (ms). */
  timeoutMs?: number;
  /** After a Redis failure, use the fallback without trying Redis for this long (ms). */
  cooldownMs?: number;
  /** At most one warning per this interval; further failures are counted into it (ms). */
  logIntervalMs?: number;
}

/**
 * Shared rate-limit storage for multi-replica deployments (THROTTLE_STORAGE=redis).
 *
 * Fails OPEN to per-process limits: when Redis errors or does not answer within `timeoutMs`, the hit
 * is counted in an in-memory store instead (same limits, per API replica) and Redis is skipped for
 * `cooldownMs`, so a Redis outage never turns every request — /auth/csrf included — into a 500 or
 * a multi-second wait. Failures are logged at most once per `logIntervalMs`.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly fallback = new ThrottlerStorageService();
  private readonly timeoutMs: number;
  private readonly cooldownMs: number;
  private readonly logIntervalMs: number;
  private skipRedisUntil = 0;
  private lastLogAt = 0;
  private unloggedFailures = 0;

  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'throttle:',
    options: RedisThrottlerStorageOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 500;
    this.cooldownMs = options.cooldownMs ?? 5_000;
    this.logIntervalMs = options.logIntervalMs ?? 60_000;
  }

  /** True while Redis is being bypassed after a failure (tests, diagnostics). */
  get degraded(): boolean {
    return Date.now() < this.skipRedisUntil;
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    if (Date.now() < this.skipRedisUntil) {
      return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
    }
    try {
      return await this.incrementInRedis(key, ttl, limit, blockDuration, throttlerName);
    } catch (err) {
      this.skipRedisUntil = Date.now() + this.cooldownMs;
      this.logFailure(err);
      return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
    }
  }

  private async incrementInRedis(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const base = `${this.prefix}${throttlerName}:${key}`;
    const call = this.redis.eval(
      SCRIPT,
      2,
      `${base}:hits`,
      `${base}:block`,
      String(Math.max(1, Math.trunc(ttl))),
      String(limit),
      String(Math.max(1, Math.trunc(blockDuration))),
    );
    // A command that outlives the timeout still settles later: never leave its rejection unhandled.
    call.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Redis did not answer within ${this.timeoutMs} ms`)), this.timeoutMs);
      timer.unref?.();
    });
    try {
      const [hits, pttl, blocked, blockPttl] = (await Promise.race([call, timeout])) as [number, number, number, number];
      return {
        totalHits: hits,
        timeToExpire: Math.max(0, Math.ceil(pttl / 1000)),
        isBlocked: blocked === 1,
        timeToBlockExpire: blocked === 1 ? Math.max(0, Math.ceil(blockPttl / 1000)) : 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private logFailure(err: unknown): void {
    this.unloggedFailures += 1;
    const now = Date.now();
    if (now - this.lastLogAt < this.logIntervalMs) return;
    this.logger.warn(
      { failures: this.unloggedFailures, error: err instanceof Error ? err.message : String(err) },
      'Rate-limit storage (Redis) unavailable; using per-process limits',
    );
    this.lastLogAt = now;
    this.unloggedFailures = 0;
  }
}
