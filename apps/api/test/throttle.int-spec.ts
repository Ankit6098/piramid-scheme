import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
});
