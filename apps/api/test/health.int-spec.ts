import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import { ProbeModule } from './utils/probe.module';

describe('health & HTTP pipeline', () => {
  let t: TestApp;

  beforeAll(async () => {
    await resetDatabase();
    t = await createTestApp({ imports: [ProbeModule] });
  });
  afterAll(async () => {
    await t?.close();
    await disconnectTestPrisma();
  });

  it('GET /api/v1/health is public liveness', async () => {
    const res = await t.client().get('/api/v1/health').expect(200);
    expect(res.body.data.status).toBe('ok');
    expect(typeof res.body.data.uptimeSeconds).toBe('number');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('GET /api/v1/health/ready checks the database and redis', async () => {
    const res = await t.client().get('/api/v1/health/ready').expect(200);
    expect(res.body).toEqual({ data: { status: 'ok', checks: { database: 'up', redis: 'up' } } });
  });

  it('echoes a safe client x-request-id and uses it in error bodies', async () => {
    const res = await t.client().get('/api/v1/does-not-exist').set('x-request-id', 'req-test-12345').expect(404);
    expect(res.headers['x-request-id']).toBe('req-test-12345');
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'req-test-12345' } });
  });

  it('serializes bigint as decimal strings', async () => {
    const res = await t.client().get('/api/v1/__probe/bigint').expect(200);
    expect(res.body.data).toEqual({ amountMinor: '9007199254740993', nested: [{ v: '1' }], when: '2026-01-01T00:00:00.000Z' });
  });

  it('hides internals of unexpected errors (500 INTERNAL_ERROR)', async () => {
    const res = await t.client().get('/api/v1/__probe/boom').expect(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(res.body.error.requestId).toBeTruthy();
  });

  it('rejects bodies over 100kb with 413 PAYLOAD_TOO_LARGE and malformed JSON with 400', async () => {
    const big = await t.client().post('/api/v1/__probe/public-echo').send({ blob: 'x'.repeat(110 * 1024) }).expect(413);
    expect(big.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    const bad = await t.client().post('/api/v1/__probe/public-echo').set('content-type', 'application/json').send('{"a":').expect(400);
    expect(bad.body.error).toMatchObject({ code: 'VALIDATION_FAILED', message: 'Malformed JSON body' });
  });

  it('validates the Idempotency-Key header', async () => {
    const missing = await t.client().post('/api/v1/__probe/idempotent').expect(400);
    expect(missing.body.error.code).toBe('VALIDATION_FAILED');
    await t.client().post('/api/v1/__probe/idempotent').set('Idempotency-Key', 'short').expect(400);
    const ok = await t.client().post('/api/v1/__probe/idempotent').set('Idempotency-Key', 'key-12345678').expect(200);
    expect(ok.body.data.key).toBe('key-12345678');
  });

  it('applies the opt-in otp throttler (429 RATE_LIMITED) only where marked', async () => {
    const c = t.client();
    await c.get('/api/v1/__probe/otp-limited').expect(200);
    await c.get('/api/v1/__probe/otp-limited').expect(200);
    const limited = await c.get('/api/v1/__probe/otp-limited').expect(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after-otp'] ?? limited.headers['retry-after']).toBeDefined();
    // The guard's wait is exposed in the body and as the standard Retry-After header (web shows it).
    const wait = limited.body.error.details?.retryAfterSeconds;
    expect(wait).toBeGreaterThan(0);
    expect(Number(limited.headers['retry-after'])).toBe(wait);
    // unmarked routes are not affected by the otp/auth throttlers
    for (let i = 0; i < 5; i++) await c.get('/api/v1/__probe/bigint').expect(200);
  });

  it('sends CORS headers only for allowed origins', async () => {
    const allowed = await t.client().get('/api/v1/health').set('Origin', 'http://localhost:3000').expect(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    const denied = await t.client().get('/api/v1/health').set('Origin', 'https://evil.example').expect(200);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});
