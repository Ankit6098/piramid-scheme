import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LAST_SEEN_UPDATE_INTERVAL_MS } from '../src/common/auth/session-auth.service';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import { createProgram, createUser, loginAs } from './utils/factories';
import { ProbeModule } from './utils/probe.module';

const ME = '/api/v1/__probe/me';
const ADMIN = '/api/v1/admin/__probe/ping';

function setCookies(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers['set-cookie'];
  return Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
}

describe('SessionAuthGuard / PermissionsGuard', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ imports: [ProbeModule] });
  });
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await t?.close();
    await disconnectTestPrisma();
  });

  it('401 UNAUTHENTICATED without a session cookie', async () => {
    const res = await t.client().get(ME).expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('401 and clears the cookie for an unknown token', async () => {
    const res = await t.clientWithSession('x'.repeat(43)).get(ME).expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(setCookies(res).some((c) => c.startsWith('sid=;'))).toBe(true);
  });

  it('resolves a valid session into an AuthContext', async () => {
    const program = await createProgram(t.prisma);
    const user = await createUser(t.prisma, { roles: ['PROGRAM_ADMIN'], programScopes: [program.id] });
    const c = await loginAs(t, user, { mfaVerified: false });
    const res = await c.get(ME).expect(200);
    expect(res.body.data).toMatchObject({
      userId: user.id,
      sessionId: c.sessionId,
      email: user.email,
      fullName: user.fullName,
      isAdmin: true,
      mfaVerified: false,
      programScopes: [program.id],
    });
    expect([...res.body.data.roles].sort()).toEqual(['MEMBER', 'PROGRAM_ADMIN']);
    expect(res.body.data.permissions).toContain('programs:write');
    expect(res.body.data.permissions).not.toContain('settings:write');
  });

  it('rejects an expired session', async () => {
    const user = await createUser(t.prisma);
    const c = await loginAs(t, user);
    await t.prisma.session.update({
      where: { id: c.sessionId },
      data: { createdAt: new Date(Date.now() - 3 * 3_600_000), expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await c.get(ME).expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a revoked session', async () => {
    const user = await createUser(t.prisma);
    const c = await loginAs(t, user);
    await t.prisma.session.update({ where: { id: c.sessionId }, data: { revokedAt: new Date(), revokeReason: 'logout' } });
    await c.get(ME).expect(401);
  });

  it('rejects and revokes an idle session', async () => {
    const user = await createUser(t.prisma);
    const c = await loginAs(t, user);
    const idleMs = t.config.security.sessionIdleTimeoutMinutes * 60_000;
    await t.prisma.session.update({ where: { id: c.sessionId }, data: { lastSeenAt: new Date(Date.now() - idleMs - 60_000) } });
    await c.get(ME).expect(401);
    const s = await t.prisma.session.findUniqueOrThrow({ where: { id: c.sessionId } });
    expect(s.revokedAt).not.toBeNull();
    expect(s.revokeReason).toBe('idle_timeout');
  });

  it('refreshes lastSeenAt at most every 5 minutes', async () => {
    const user = await createUser(t.prisma);
    const c = await loginAs(t, user);
    const recent = new Date(Date.now() - 60_000);
    await t.prisma.session.update({ where: { id: c.sessionId }, data: { lastSeenAt: recent } });
    await c.get(ME).expect(200);
    expect((await t.prisma.session.findUniqueOrThrow({ where: { id: c.sessionId } })).lastSeenAt.getTime()).toBe(recent.getTime());

    const old = new Date(Date.now() - LAST_SEEN_UPDATE_INTERVAL_MS - 60_000);
    await t.prisma.session.update({ where: { id: c.sessionId }, data: { lastSeenAt: old } });
    await c.get(ME).expect(200);
    const after = await t.prisma.session.findUniqueOrThrow({ where: { id: c.sessionId } });
    expect(after.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 10_000);
  });

  it('403 ACCOUNT_SUSPENDED for a suspended user, 401 for a deactivated one', async () => {
    const suspended = await createUser(t.prisma, { status: 'SUSPENDED' });
    const r1 = await (await loginAs(t, suspended)).get(ME).expect(403);
    expect(r1.body.error.code).toBe('ACCOUNT_SUSPENDED');

    const gone = await createUser(t.prisma, { status: 'DEACTIVATED' });
    const r2 = await (await loginAs(t, gone)).get(ME).expect(401);
    expect(r2.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('admin routes: member → 403 FORBIDDEN, admin without MFA → 403 MFA_REQUIRED, admin with MFA → 200', async () => {
    const member = await createUser(t.prisma);
    const r1 = await (await loginAs(t, member)).get(ADMIN).expect(403);
    expect(r1.body.error.code).toBe('FORBIDDEN');

    const admin = await createUser(t.prisma, { roles: ['FINANCE_REVIEWER'] });
    const noMfa = await loginAs(t, admin, { mfaVerified: false });
    const r2 = await noMfa.get(ADMIN).expect(403);
    expect(r2.body.error.code).toBe('MFA_REQUIRED');
    // case-insensitive routing must not bypass the admin check
    const r3 = await noMfa.get('/api/v1/ADMIN/__probe/ping').expect(403);
    expect(r3.body.error.code).toBe('MFA_REQUIRED');

    const withMfa = await loginAs(t, admin, { mfaVerified: true });
    const r4 = await withMfa.get(ADMIN).expect(200);
    expect(r4.body.data).toEqual({ pong: true, userId: admin.id });
  });

  it('@RequirePermissions requires all listed permissions', async () => {
    const member = await createUser(t.prisma);
    const r1 = await (await loginAs(t, member)).get('/api/v1/__probe/needs-approve').expect(403);
    expect(r1.body.error).toMatchObject({ code: 'FORBIDDEN', details: { missingPermissions: ['rewards:approve', 'rewards:read'] } });

    const programAdmin = await createUser(t.prisma, { roles: ['PROGRAM_ADMIN'] }); // has rewards:read only
    const r2 = await (await loginAs(t, programAdmin)).get('/api/v1/__probe/needs-approve').expect(403);
    expect(r2.body.error.details.missingPermissions).toEqual(['rewards:approve']);

    const reviewer = await createUser(t.prisma, { roles: ['FINANCE_REVIEWER'] });
    await (await loginAs(t, reviewer)).get('/api/v1/__probe/needs-approve').expect(200);
  });

  it('@OptionalAuth resolves a session when present and ignores bad cookies', async () => {
    const anon = await t.client().get('/api/v1/__probe/optional').expect(200);
    expect(anon.body.data.userId).toBeNull();
    const user = await createUser(t.prisma);
    const res = await (await loginAs(t, user)).get('/api/v1/__probe/optional').expect(200);
    expect(res.body.data.userId).toBe(user.id);
    const bad = await t.clientWithSession('y'.repeat(43)).get('/api/v1/__probe/optional').expect(200);
    expect(bad.body.data.userId).toBeNull();
  });

  it('validates bodies with the global ZodValidationPipe and serializes bigint', async () => {
    const user = await createUser(t.prisma);
    const c = await loginAs(t, user);
    const bad = await c.post('/api/v1/__probe/echo').send({ name: 'x', amountMinor: 'abc' }).expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    expect(bad.body.error.details.issues.map((i: { path: string }) => i.path).sort()).toEqual(['amountMinor', 'name']);
    const good = await c.post('/api/v1/__probe/echo').send({ name: 'Bob', amountMinor: '9007199254740993' }).expect(200);
    expect(good.body.data).toEqual({ name: 'Bob', amountMinor: '18014398509481986', userId: user.id });
  });
});
