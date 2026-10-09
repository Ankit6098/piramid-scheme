import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import { createUser, loginAs } from './utils/factories';
import { ProbeModule } from './utils/probe.module';

const URL = '/api/v1/__probe/public-echo';

describe('CSRF protection', () => {
  let t: TestApp;

  beforeAll(async () => {
    await resetDatabase();
    t = await createTestApp({ imports: [ProbeModule] });
  });
  afterAll(async () => {
    await t?.close();
    await disconnectTestPrisma();
  });

  it('rejects a mutation without token (403 CSRF_FAILED)', async () => {
    const res = await t.client().withoutCsrf().post(URL).send({ a: 1 }).expect(403);
    expect(res.body.error.code).toBe('CSRF_FAILED');
  });

  it('rejects a header that does not match the cookie', async () => {
    const res = await t
      .client()
      .withoutCsrf()
      .post(URL)
      .set('Cookie', 'csrf_token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      .set('x-csrf-token', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
      .send({})
      .expect(403);
    expect(res.body.error.code).toBe('CSRF_FAILED');
  });

  it('accepts a matching double-submit pair', async () => {
    const res = await t.client().post(URL).send({ a: 1 }).expect(200);
    expect(res.body.data.received).toEqual({ a: 1 });
  });

  it('checks Origin / Referer against the allow-list', async () => {
    await t.client().withHeaders({ Origin: 'https://evil.example' }).post(URL).send({}).expect(403);
    await t.client().withHeaders({ Origin: 'null' }).post(URL).send({}).expect(403);
    await t.client().withHeaders({ Referer: 'https://evil.example/page' }).post(URL).send({}).expect(403);
    await t.client().withHeaders({ Origin: 'http://localhost:3000' }).post(URL).send({}).expect(200);
    await t.client().withHeaders({ Referer: `${t.config.app.publicOrigin}/admin/settings` }).post(URL).send({}).expect(200);
  });

  it('runs before authentication (CSRF failure wins over missing session)', async () => {
    const res = await t.client().withoutCsrf().post('/api/v1/__probe/echo').send({}).expect(403);
    expect(res.body.error.code).toBe('CSRF_FAILED');
  });

  it('protects authenticated mutations too', async () => {
    const user = await createUser(t.prisma);
    const c = await loginAs(t, user);
    await c.withoutCsrf().post('/api/v1/__probe/echo').send({ name: 'Bob', amountMinor: '1' }).expect(403);
    await c.post('/api/v1/__probe/echo').send({ name: 'Bob', amountMinor: '1' }).expect(200);
  });

  it('GET /api/v1/auth/csrf issues a usable token cookie', async () => {
    const res = await t.client().get('/api/v1/auth/csrf').expect(200);
    const token: string = res.body.data.csrfToken;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('csrf_token='));
    expect(cookie).toBeDefined();
    expect(cookie).toContain(`csrf_token=${token}`);
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('HttpOnly');
    await t
      .client()
      .withoutCsrf()
      .post(URL)
      .set('Cookie', `csrf_token=${token}`)
      .set('x-csrf-token', token)
      .send({})
      .expect(200);
  });

  it('@SkipCsrf routes accept mutations without a token', async () => {
    await t.client().withoutCsrf().post('/api/v1/__probe/webhook').send({}).expect(200);
  });
});
