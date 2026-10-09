import type { ThrottlerStorage } from '@nestjs/throttler';
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

/** Shared rate-limit storage for multi-replica deployments (THROTTLE_STORAGE=redis). */
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'throttle:',
  ) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const base = `${this.prefix}${throttlerName}:${key}`;
    const [hits, pttl, blocked, blockPttl] = (await this.redis.eval(
      SCRIPT,
      2,
      `${base}:hits`,
      `${base}:block`,
      String(Math.max(1, Math.trunc(ttl))),
      String(limit),
      String(Math.max(1, Math.trunc(blockDuration))),
    )) as [number, number, number, number];
    return {
      totalHits: hits,
      timeToExpire: Math.max(0, Math.ceil(pttl / 1000)),
      isBlocked: blocked === 1,
      timeToBlockExpire: blocked === 1 ? Math.max(0, Math.ceil(blockPttl / 1000)) : 0,
    };
  }
}
