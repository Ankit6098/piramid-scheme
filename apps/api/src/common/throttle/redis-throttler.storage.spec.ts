import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { RedisThrottlerStorage } from './redis-throttler.storage';

function fakeRedis(evalImpl: () => Promise<unknown>) {
  return { eval: vi.fn(evalImpl) } as unknown as Redis & { eval: ReturnType<typeof vi.fn> };
}

describe('RedisThrottlerStorage', () => {
  it('maps the Lua result (hits, ttl, block) from Redis', async () => {
    const redis = fakeRedis(async () => [3, 42_000, 0, 0]);
    const storage = new RedisThrottlerStorage(redis);
    await expect(storage.increment('ip', 60_000, 10, 60_000, 'default')).resolves.toEqual({
      totalHits: 3,
      timeToExpire: 42,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
    expect(redis.eval.mock.calls[0]!.slice(2, 4)).toEqual(['throttle:default:ip:hits', 'throttle:default:ip:block']);
  });

  it('fails open to per-process counters when Redis errors, still enforcing the limit', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const redis = fakeRedis(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:6399');
    });
    const storage = new RedisThrottlerStorage(redis, 'throttle:', { cooldownMs: 60_000 });
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await storage.increment('ip', 60_000, 3, 60_000, 'default'));
    expect(results.map((r) => r.totalHits)).toEqual([1, 2, 3, 4]);
    expect(results.map((r) => r.isBlocked)).toEqual([false, false, false, true]);
    expect(storage.degraded).toBe(true);
    // Redis was tried once; during the cooldown the fallback answers directly.
    expect(redis.eval).toHaveBeenCalledTimes(1);
    // One warning, not one per request.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('gives up on a Redis that does not answer within the timeout', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const redis = fakeRedis(() => new Promise(() => undefined));
    const storage = new RedisThrottlerStorage(redis, 'throttle:', { timeoutMs: 30 });
    const started = Date.now();
    const r = await storage.increment('ip', 60_000, 10, 60_000, 'default');
    expect(r).toMatchObject({ totalHits: 1, isBlocked: false });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('retries Redis after the cooldown and logs at most once per interval', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let up = false;
    const redis = fakeRedis(async () => {
      if (!up) throw new Error('down');
      return [1, 1000, 0, 0];
    });
    const storage = new RedisThrottlerStorage(redis, 'throttle:', { cooldownMs: 0, logIntervalMs: 60_000 });
    await storage.increment('a', 1000, 10, 1000, 'default');
    await storage.increment('b', 1000, 10, 1000, 'default');
    expect(warn).toHaveBeenCalledTimes(1);
    up = true;
    await expect(storage.increment('c', 1000, 10, 1000, 'default')).resolves.toMatchObject({ totalHits: 1, timeToExpire: 1 });
    expect(redis.eval).toHaveBeenCalledTimes(3);
  });
});
