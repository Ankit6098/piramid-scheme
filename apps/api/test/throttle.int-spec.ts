import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisService } from '../src/common/redis/redis.service';
import { LoginThrottleService } from '../src/common/throttle/login-throttle.service';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import { ProbeModule } from './utils/probe.module';

describe('rate limiting', () => {
  let t: TestApp;

  beforeAll(async () => {
    await resetDatabase();
    t = await createTestApp({
      imports: [ProbeModule],
      env: { THROTTLE_AUTH_LIMIT: '3', THROTTLE_DEFAULT_LIMIT: '8', TRUST_PROXY: 'true' },
    });
  });
  afterAll(async () => {
    // remove the Redis keys created by this run (test IPs are 198.18.x.y)
    const redis = t.get(RedisService).redis;
    const keys = await redis.keys('login-throttle:v1:*198.18.*');
    if (keys.length) await redis.del(...keys);
    await t?.close();
    await disconnectTestPrisma();
  });

  it('applies the strict `auth` throttler to @RateLimit("auth") routes, per client IP', async () => {
    const fromA = t.client().withHeaders({ 'X-Forwarded-For': '203.0.113.10' });
    for (let i = 0; i < 3; i++) await fromA.post('/api/v1/__probe/auth-limited').expect(200);
    const res = await fromA.post('/api/v1/__probe/auth-limited').expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    // another client IP (trusted proxy header) has its own budget
    await t.client().withHeaders({ 'X-Forwarded-For': '203.0.113.11' }).post('/api/v1/__probe/auth-limited').expect(200);
  });

  it('applies the default throttler to every route', async () => {
    const c = t.client().withHeaders({ 'X-Forwarded-For': '198.51.100.7' });
    for (let i = 0; i < 8; i++) await c.get('/api/v1/__probe/bigint').expect(200);
    const res = await c.get('/api/v1/__probe/bigint').expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.headers['retry-after']).toBeDefined();
    // health probes are exempt from the default throttler
    for (let i = 0; i < 12; i++) await c.get('/api/v1/health').expect(200);
  });

  describe('LoginThrottleService (Redis failure counters with exponential backoff)', () => {
    const ip = () => `198.18.${randomInt(256)}.${randomInt(256)}`;
    const email = () => `throttle-${Date.now()}-${randomInt(1e9)}@example.test`;

    it('blocks a (email, IP) pair after 5 failures: 30 s, then doubling; other IPs are unaffected', async () => {
      const svc = t.get(LoginThrottleService);
      expect(svc.policy).toMatchObject({ freeAttempts: 5, ipFreeAttempts: 20, baseMs: 30_000, maxMs: 900_000 });
      const key = svc.emailKey(email());
      const addr = ip();
      for (let i = 1; i <= 4; i++) {
        expect(await svc.recordFailure(key, addr)).toMatchObject({ failures: i, retryAfterSeconds: null });
        expect(await svc.check(key, addr)).toEqual({ allowed: true });
      }
      expect(await svc.recordFailure(key, addr)).toMatchObject({ failures: 5, retryAfterSeconds: 30 });
      const blocked = await svc.check(key, addr);
      expect(blocked).toMatchObject({ allowed: false, scope: 'account' });
      expect(blocked.allowed === false && blocked.retryAfterSeconds).toBeGreaterThanOrEqual(29);
      expect(await svc.recordFailure(key, addr)).toMatchObject({ failures: 6, retryAfterSeconds: 60 });
      expect(await svc.recordFailure(key, addr)).toMatchObject({ failures: 7, retryAfterSeconds: 120 });

      // the owner on another network is not locked out (no global account lock)
      expect(await svc.check(key, ip())).toEqual({ allowed: true });

      try {
        svc.assertAllowed(await svc.check(key, addr));
        expect.unreachable('should be rate limited');
      } catch (e) {
        expect(e).toMatchObject({ code: 'RATE_LIMITED', httpStatus: 429 });
        expect((e as { details: { retryAfterSeconds: number } }).details.retryAfterSeconds).toBeGreaterThan(60);
      }

      // a successful login clears the pair counter
      await svc.reset(key, addr);
      expect(await svc.check(key, addr)).toEqual({ allowed: true });
      expect(await svc.recordFailure(key, addr)).toMatchObject({ failures: 1, retryAfterSeconds: null });
    });

    it('caps the block at 15 minutes', async () => {
      const svc = t.get(LoginThrottleService);
      const key = svc.emailKey(email());
      const addr = ip();
      let last = null as number | null;
      for (let i = 0; i < 12; i++) last = (await svc.recordFailure(key, addr)).retryAfterSeconds;
      expect(last).toBe(900);
    });

    it('uses the same counters for unknown emails, keyed by a case-insensitive HMAC', async () => {
      const svc = t.get(LoginThrottleService);
      const e = email();
      expect(svc.emailKey(e.toUpperCase())).toBe(svc.emailKey(` ${e} `));
      expect(svc.emailKey(e)).toMatch(/^[0-9a-f]{64}$/);
      expect(svc.emailKey(e)).not.toContain(e);
    });

    it('blocks an IP after 20 failures across any emails (credential stuffing)', async () => {
      const svc = t.get(LoginThrottleService);
      const addr = ip();
      let result = null as Awaited<ReturnType<typeof svc.recordFailure>> | null;
      for (let i = 0; i < 20; i++) result = await svc.recordFailure(svc.emailKey(email()), addr);
      expect(result).toMatchObject({ ipFailures: 20, retryAfterSeconds: 30 });
      const fresh = await svc.check(svc.emailKey(email()), addr);
      expect(fresh).toMatchObject({ allowed: false, scope: 'ip' });
      // a successful login of one account does not lift the IP block
      await svc.reset(svc.emailKey(email()), addr);
      expect((await svc.check(svc.emailKey(email()), addr)).allowed).toBe(false);
    });
  });
});
