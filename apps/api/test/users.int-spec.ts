import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { totp } from '../src/common/crypto/totp';
import { RedisService } from '../src/common/redis/redis.service';
import { createTestApp, type TestApp, type TestClient } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import { createTotpFactor, createUser, factoryAdmin, loginAs } from './utils/factories';

const PASSWORD = 'Member-password-42';
const ip = () => `198.19.${randomInt(256)}.${randomInt(1, 255)}`;
const uniqueEmail = (tag: string) => `${tag}-${Date.now().toString(36)}-${randomInt(1e9)}@example.test`;

describe('users: self-service profile & security (/users/me)', () => {
  let t: TestApp;
  let crypto: CryptoService;

  beforeAll(async () => {
    t = await createTestApp({ env: { TRUST_PROXY: 'true' } });
    crypto = t.get(CryptoService);
  });
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    const redis = t.get(RedisService).redis;
    const keys = await redis.keys('login-throttle:v1:*198.19.*');
    if (keys.length) await redis.del(...keys);
    await t?.close();
    await disconnectTestPrisma();
  });

  /** A logged-in client with its own client IP (isolates the password-check backoff). */
  async function signedIn(user: Parameters<typeof loginAs>[1], opts: Parameters<typeof loginAs>[2] = {}) {
    const s = await loginAs(t, user, opts);
    return Object.assign(s.withHeaders({ 'X-Forwarded-For': ip() }), { sessionId: s.sessionId, token: s.token });
  }

  async function latestCode(where: { email?: string; userId?: string; purpose: 'EMAIL_CHANGE' }) {
    const ch = await t.prisma.emailChallenge.findFirstOrThrow({
      where: { ...where, consumedAt: null, invalidatedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    const rows = await t.prisma.$queryRaw<Array<{ payload: { codeCiphertext: string } }>>`
      SELECT "payload" FROM "outbox_messages" WHERE "topic" = 'email.otp' AND "payload"->>'challengeId' = ${ch.id}`;
    return { code: crypto.decryptOtpCode(rows[0]!.payload.codeCiphertext, ch.id), challenge: ch };
  }

  const emailsTo = async (to: string) =>
    (await t.prisma.outboxMessage.findMany({ where: { topic: 'email.send' }, orderBy: { createdAt: 'asc' } })).filter(
      (m) => (m.payload as { to?: string }).to === to,
    );

  describe('profile', () => {
    it('GET /users/me returns the own profile only, without secrets; 401 when signed out', async () => {
      const user = await createUser(t.prisma, { password: PASSWORD, fullName: 'Kavya Iyer' });
      const me = await (await signedIn(user)).get('/api/v1/users/me').expect(200);
      expect(me.body.data).toMatchObject({
        id: user.id,
        fullName: 'Kavya Iyer',
        email: user.email,
        phone: null,
        avatarUrl: null,
        roles: ['MEMBER'],
        isAdmin: false,
        hasTotpFactor: false,
      });
      expect(JSON.stringify(me.body)).not.toMatch(/passwordHash|argon2/);
      await t.client().get('/api/v1/users/me').expect(401);
    });

    it('PATCH /users/me updates name/phone/avatar (https only) and audits the changed fields masked', async () => {
      const user = await createUser(t.prisma, { fullName: 'Old Name' });
      const c = await signedIn(user);
      const res = await c
        .patch('/api/v1/users/me')
        .send({ fullName: '  New Name ', phone: '+91 98765-43210', avatarUrl: 'https://cdn.example.com/a.png' })
        .expect(200);
      expect(res.body.data).toMatchObject({ fullName: 'New Name', phone: '+919876543210', avatarUrl: 'https://cdn.example.com/a.png' });

      for (const avatarUrl of ['http://cdn.example.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA']) {
        const bad = await c.patch('/api/v1/users/me').send({ avatarUrl }).expect(400);
        expect(bad.body.error.details.issues[0].path).toBe('avatarUrl');
      }
      await c.patch('/api/v1/users/me').send({ phone: '12' }).expect(400);
      await c.patch('/api/v1/users/me').send({}).expect(400);
      const cleared = await c.patch('/api/v1/users/me').send({ phone: null, avatarUrl: null }).expect(200);
      expect(cleared.body.data).toMatchObject({ phone: null, avatarUrl: null });

      const audits = await t.prisma.auditLog.findMany({ where: { action: 'user.profile.update', resourceId: user.id }, orderBy: { createdAt: 'asc' } });
      expect(audits).toHaveLength(2);
      expect(audits[0]!.before).toEqual({ fullName: 'Old Name', phone: null, avatarUrl: null });
      expect((audits[0]!.after as { phone: string }).phone).toBe('+**********10');
      // a no-op update writes no audit entry
      await c.patch('/api/v1/users/me').send({ fullName: 'New Name' }).expect(200);
      expect(await t.prisma.auditLog.count({ where: { action: 'user.profile.update', resourceId: user.id } })).toBe(2);
    });
  });

  describe('password change', () => {
    it('requires the current password, revokes the other sessions and notifies the owner', async () => {
      const user = await createUser(t.prisma, { password: PASSWORD, fullName: 'Pat Change' });
      const current = await signedIn(user);
      const other = await signedIn(user);

      const wrong = await current
        .post('/api/v1/users/me/password')
        .send({ currentPassword: 'Not-my-pass-1', newPassword: 'Fresh-password-9' })
        .expect(400);
      expect(wrong.body.error.details.issues[0].path).toBe('currentPassword');
      const same = await current.post('/api/v1/users/me/password').send({ currentPassword: PASSWORD, newPassword: PASSWORD }).expect(400);
      expect(same.body.error.details.issues[0].path).toBe('newPassword');

      await current.post('/api/v1/users/me/password').send({ currentPassword: PASSWORD, newPassword: 'Fresh-password-9' }).expect(200);
      await current.get('/api/v1/users/me').expect(200);
      await other.get('/api/v1/users/me').expect(401);
      expect(await t.prisma.session.findUniqueOrThrow({ where: { id: other.sessionId } })).toMatchObject({ revokeReason: 'password_changed' });

      const login = (password: string) =>
        t.client().withHeaders({ 'X-Forwarded-For': ip() }).post('/api/v1/auth/login').send({ email: user.email, password });
      expect((await login(PASSWORD)).status).toBe(401);
      expect((await login('Fresh-password-9')).status).toBe(200);
      expect((await emailsTo(user.email)).map((m) => (m.payload as { data: { subject: string } }).data.subject)).toContain(
        'Your password was changed',
      );
    });

    it('notifies SUPER_ADMINs when an admin changes the password', async () => {
      const superAdmin = await factoryAdmin(t.prisma);
      const admin = await createUser(t.prisma, { roles: ['PROGRAM_ADMIN'], password: PASSWORD });
      const c = await signedIn(admin);
      await c.post('/api/v1/users/me/password').send({ currentPassword: PASSWORD, newPassword: 'Fresh-password-9' }).expect(200);
      const toSuper = await emailsTo(superAdmin.email);
      expect(toSuper).toHaveLength(1);
      expect(JSON.stringify(toSuper[0]!.payload)).not.toContain(admin.email);
    });
  });

  describe('email change', () => {
    it('answers identically for a taken address (which gets a notice) and a free one (which gets a code)', async () => {
      const user = await createUser(t.prisma, { password: PASSWORD });
      const owner = await createUser(t.prisma, { fullName: 'Owner Of Address' });
      const c = await signedIn(user);

      const badPassword = await c.post('/api/v1/users/me/email-change').send({ newEmail: uniqueEmail('x'), password: 'Wrong-pass-1' }).expect(400);
      expect(badPassword.body.error.details.issues[0].path).toBe('password');
      const sameAddress = await c.post('/api/v1/users/me/email-change').send({ newEmail: user.email, password: PASSWORD }).expect(400);
      expect(sameAddress.body.error.details.issues[0].path).toBe('newEmail');

      const free = uniqueEmail('free');
      const taken = await c.post('/api/v1/users/me/email-change').send({ newEmail: owner.email, password: PASSWORD }).expect(202);
      await t.prisma.emailChallenge.updateMany({ data: { createdAt: new Date(Date.now() - 120_000) } });
      const ok = await c.post('/api/v1/users/me/email-change').send({ newEmail: free, password: PASSWORD }).expect(202);
      expect(taken.body).toEqual(ok.body);

      expect(await t.prisma.emailChallenge.count({ where: { email: owner.email } })).toBe(0);
      expect(await t.prisma.emailChallenge.count({ where: { email: free, purpose: 'EMAIL_CHANGE', userId: user.id } })).toBe(1);
      expect((await emailsTo(owner.email)).map((m) => (m.payload as { data: { subject: string } }).data.subject)).toEqual([
        'Someone tried to use your email address',
      ]);
      // both attempts look the same in the requester's own activity log
      expect(await t.prisma.auditLog.count({ where: { action: 'user.email_change.requested', actorUserId: user.id } })).toBe(2);
    });

    it('confirms with the code from the new mailbox, revokes other sessions and notifies the old address', async () => {
      const user = await createUser(t.prisma, { password: PASSWORD, fullName: 'Mover Person' });
      const c = await signedIn(user);
      const other = await signedIn(user);
      const newEmail = uniqueEmail('moved');
      await c.post('/api/v1/users/me/email-change').send({ newEmail: newEmail.toUpperCase(), password: PASSWORD }).expect(202);
      const { code } = await latestCode({ userId: user.id, purpose: 'EMAIL_CHANGE' });

      const wrong = await c.post('/api/v1/users/me/email-change/confirm').send({ code: code === '000000' ? '111111' : '000000' }).expect(400);
      expect(wrong.body.error.code).toBe('OTP_INVALID');
      // another account cannot use this code
      const stranger = await signedIn(await createUser(t.prisma));
      await stranger.post('/api/v1/users/me/email-change/confirm').send({ code }).expect(400);

      const res = await c.post('/api/v1/users/me/email-change/confirm').send({ code }).expect(200);
      expect(res.body.data.email).toBe(newEmail);
      await c.get('/api/v1/users/me').expect(200);
      await other.get('/api/v1/users/me').expect(401);

      const notice = await emailsTo(user.email);
      expect(notice.map((m) => (m.payload as { template: string }).template)).toContain('email-changed-notice');
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'user.email.change', resourceId: user.id } });
      expect(JSON.stringify([audit.before, audit.after])).not.toContain(user.email);
      expect(JSON.stringify([audit.before, audit.after])).not.toContain(newEmail);
      await c.post('/api/v1/users/me/email-change/confirm').send({ code }).expect(400);
      await t.client().withHeaders({ 'X-Forwarded-For': ip() }).post('/api/v1/auth/login').send({ email: newEmail, password: PASSWORD }).expect(200);
    });
  });

  describe('sessions & activity', () => {
    it('lists own open sessions, revokes one or all others, and never touches another account', async () => {
      const user = await createUser(t.prisma);
      const someoneElse = await createUser(t.prisma);
      const current = await signedIn(user);
      const second = await signedIn(user);
      const third = await signedIn(user);
      const foreign = await signedIn(someoneElse);

      const list = await current.get('/api/v1/users/me/sessions?limit=2').expect(200);
      expect(list.body.data).toHaveLength(2);
      expect(list.body.page.nextCursor).toBeTruthy();
      const rest = await current.get(`/api/v1/users/me/sessions?limit=2&cursor=${list.body.page.nextCursor}`).expect(200);
      const all = [...list.body.data, ...rest.body.data] as Array<{ id: string; current: boolean }>;
      expect(all.map((s) => s.id).sort()).toEqual([current.sessionId, second.sessionId, third.sessionId].sort());
      expect(all.filter((s) => s.current).map((s) => s.id)).toEqual([current.sessionId]);
      await current.get('/api/v1/users/me/sessions?cursor=not-a-cursor').expect(400);

      await current.delete(`/api/v1/users/me/sessions/${foreign.sessionId}`).expect(404);
      await foreign.get('/api/v1/users/me').expect(200);
      const revoked = await current.delete(`/api/v1/users/me/sessions/${second.sessionId}`).expect(200);
      expect(revoked.body.data).toEqual({ revoked: true, current: false });
      await second.get('/api/v1/users/me').expect(401);

      const others = await current.post('/api/v1/users/me/sessions/revoke-others').expect(200);
      expect(others.body.data).toEqual({ revoked: 1 });
      await third.get('/api/v1/users/me').expect(401);
      await current.get('/api/v1/users/me').expect(200);

      const self = await current.delete(`/api/v1/users/me/sessions/${current.sessionId}`).expect(200);
      expect(self.body.data.current).toBe(true);
      await current.get('/api/v1/users/me').expect(401);
    });

    it('shows the caller only their own activity, with masked IPs', async () => {
      const user = await createUser(t.prisma);
      const other = await createUser(t.prisma);
      const c = await signedIn(user);
      const o = await signedIn(other);
      await c.patch('/api/v1/users/me').send({ fullName: 'Changed Name' }).expect(200);
      await o.patch('/api/v1/users/me').send({ fullName: 'Other Changed' }).expect(200);
      const res = await c.get('/api/v1/users/me/activity').expect(200);
      const rows = res.body.data as Array<{ action: string; ipAddress: string | null }>;
      expect(rows.map((r) => r.action)).toEqual(['user.profile.update']);
      expect(rows[0]!.ipAddress).toMatch(/^198\.19\.\d+\.x$/);
      expect(res.body.page).toMatchObject({ nextCursor: null });
      expect(JSON.stringify(res.body)).not.toContain(other.id);
    });
  });

  describe('authenticator reset (admins)', () => {
    it('requires the current TOTP code, revokes the factor and other sessions, then allows re-enrollment', async () => {
      const superAdmin = await factoryAdmin(t.prisma);
      const admin = await createUser(t.prisma, { roles: ['FINANCE_REVIEWER'] });
      const { secret } = await createTotpFactor(t, admin);
      const c = await signedIn(admin, { mfa: 'TOTP' });
      const other = await signedIn(admin, { mfa: 'TOTP' });

      await c.post('/api/v1/users/me/mfa/totp/reset').send({ code: totp(secret, Date.now() - 10 * 60_000) }).expect(400);
      const res = await c.post('/api/v1/users/me/mfa/totp/reset').send({ code: totp(secret) }).expect(200);
      expect(res.body.data).toMatchObject({ hasTotpFactor: false, totpEnrolledAt: null });
      expect(await t.prisma.userMfaFactor.count({ where: { userId: admin.id, revokedAt: null } })).toBe(0);
      await other.get('/api/v1/users/me').expect(401);
      expect(await emailsTo(superAdmin.email)).toHaveLength(1);

      const setup = await c.post('/api/v1/auth/mfa/totp/setup').expect(200);
      const confirmed = await c.post('/api/v1/auth/mfa/totp/confirm').send({ code: totp(setup.body.data.secret) }).expect(200);
      expect(confirmed.body.data.user).toMatchObject({ hasTotpFactor: true, adminAccess: true });
    });

    it('is not available to members', async () => {
      const member = await createUser(t.prisma);
      const c = await signedIn(member);
      expect((await c.post('/api/v1/users/me/mfa/totp/reset').send({ code: '123456' }).expect(403)).body.error.code).toBe('FORBIDDEN');
    });
  });
});
