import { randomInt } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../src/common/auth/cookies';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { sha256Hex } from '../src/common/crypto/tokens';
import { totp } from '../src/common/crypto/totp';
import { RedisService } from '../src/common/redis/redis.service';
import { TotpLockoutService } from '../src/modules/auth/totp-lockout.service';
import { createTestApp, type TestApp, type TestClient } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import { createTotpFactor, createUser, factoryAdmin, loginAs } from './utils/factories';
import { ProbeModule } from './utils/probe.module';

const PASSWORD = 'Admin-password-42';
const ip = () => `198.19.${randomInt(256)}.${randomInt(1, 255)}`;

function cookieFrom(res: Response, name: string): string | null {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const c of list) {
    const [pair] = c.split(';');
    const [k, ...v] = (pair ?? '').split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

describe('auth: admin MFA (email OTP → TOTP enrollment, TOTP verification)', () => {
  let t: TestApp;
  let crypto: CryptoService;

  beforeAll(async () => {
    t = await createTestApp({ imports: [ProbeModule], env: { TRUST_PROXY: 'true' } });
    crypto = t.get(CryptoService);
  });
  beforeEach(async () => {
    await resetDatabase();
    await factoryAdmin(t.prisma);
  });
  afterAll(async () => {
    const redis = t.get(RedisService).redis;
    const keys = await redis.keys('login-throttle:v1:*198.19.*');
    if (keys.length) await redis.del(...keys);
    await t?.close();
    await disconnectTestPrisma();
  });

  const anon = (addr = ip()): TestClient => t.client().withHeaders({ 'X-Forwarded-For': addr });
  const as = (token: string, addr = ip()): TestClient => t.clientWithSession(token).withHeaders({ 'X-Forwarded-For': addr });

  async function login(email: string, addr = ip()) {
    const res = await anon(addr).post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
    return { res, token: cookieFrom(res, SESSION_COOKIE)!, addr };
  }

  async function mfaCode(sessionId: string): Promise<string> {
    const ch = await t.prisma.emailChallenge.findFirstOrThrow({
      where: { purpose: 'LOGIN_MFA', sessionId, consumedAt: null, invalidatedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    const rows = await t.prisma.$queryRaw<Array<{ payload: { codeCiphertext: string } }>>`
      SELECT "payload" FROM "outbox_messages" WHERE "topic" = 'email.otp' AND "payload"->>'challengeId' = ${ch.id}`;
    return crypto.decryptOtpCode(rows[0]!.payload.codeCiphertext, ch.id);
  }

  const sessionOf = (token: string) => t.prisma.session.findUniqueOrThrow({ where: { tokenHash: sha256Hex(token) } });

  it('first admin sign-in: email code bound to the session → TOTP setup → confirm → admin access, rotating the session each step', async () => {
    const admin = await createUser(t.prisma, { roles: ['PROGRAM_ADMIN'], password: PASSWORD, fullName: 'Pooja Admin' });
    const { res, token: t1, addr } = await login(admin.email);
    expect(res.body.data).toMatchObject({
      mfaRequired: true,
      method: 'TOTP_ENROLLMENT',
      user: { isAdmin: true, adminAccess: false, mfaMethod: null, hasTotpFactor: false },
    });
    const s1 = await sessionOf(t1);
    expect(s1.mfaMethod).toBeNull();
    expect(s1.expiresAt.getTime() - s1.createdAt.getTime()).toBe(12 * 3_600_000);

    const denied = await as(t1, addr).get('/api/v1/admin/__probe/ping').expect(403);
    expect(denied.body.error).toMatchObject({ code: 'MFA_REQUIRED', details: { reason: 'TOTP_ENROLLMENT_REQUIRED' } });
    // TOTP enrollment needs the email step first; TOTP verification needs a factor
    expect((await as(t1, addr).post('/api/v1/auth/mfa/totp/setup').expect(403)).body.error.code).toBe('MFA_REQUIRED');
    expect((await as(t1, addr).post('/api/v1/auth/mfa/totp/verify').send({ code: '123456' }).expect(403)).body.error.code).toBe(
      'MFA_REQUIRED',
    );

    const sent = await as(t1, addr).post('/api/v1/auth/mfa/email/send').expect(200);
    expect(sent.body.data).toMatchObject({ resendAfterSeconds: 60 });
    expect(sent.body.data.sentTo).toMatch(/^u\*\*\*@e\*\*\*\.test$/);
    const ch = await t.prisma.emailChallenge.findFirstOrThrow({ where: { purpose: 'LOGIN_MFA', userId: admin.id } });
    expect(ch.sessionId).toBe(s1.id);
    const cooldown = await as(t1, addr).post('/api/v1/auth/mfa/email/send').expect(429);
    expect(cooldown.body.error.code).toBe('OTP_COOLDOWN');
    const code = await mfaCode(s1.id);

    // a code requested by one session cannot elevate another session of the same admin
    const other = await login(admin.email);
    const cross = await as(other.token, other.addr).post('/api/v1/auth/mfa/email/verify').send({ code }).expect(400);
    expect(cross.body.error.code).toBe('OTP_INVALID');

    const verified = await as(t1, addr).post('/api/v1/auth/mfa/email/verify').send({ code }).expect(200);
    expect(verified.body.data.user).toMatchObject({ mfaMethod: 'EMAIL_OTP', adminAccess: false, hasTotpFactor: false });
    const t2 = cookieFrom(verified, SESSION_COOKIE)!;
    expect(t2).toBeTruthy();
    expect(t2).not.toBe(t1);
    expect(await t.prisma.session.findUniqueOrThrow({ where: { id: s1.id } })).toMatchObject({ revokeReason: 'mfa_rotated' });
    await as(t1, addr).get('/api/v1/auth/session').expect(401);
    // email OTP never grants admin access
    const stillDenied = await as(t2, addr).get('/api/v1/admin/__probe/ping').expect(403);
    expect(stillDenied.body.error.details.reason).toBe('TOTP_ENROLLMENT_REQUIRED');
    // the email step is complete for this session
    await as(t2, addr).post('/api/v1/auth/mfa/email/verify').send({ code }).expect(409);

    const setup = await as(t2, addr).post('/api/v1/auth/mfa/totp/setup').expect(200);
    const { secret, otpauthUri, issuer, accountName } = setup.body.data as Record<string, string>;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(accountName).toBe(admin.email);
    expect(otpauthUri).toContain(`secret=${secret}`);
    expect(otpauthUri).toContain(`issuer=${encodeURIComponent(issuer!)}`);
    const factor = await t.prisma.userMfaFactor.findFirstOrThrow({ where: { userId: admin.id, revokedAt: null } });
    expect(factor.confirmedAt).toBeNull();
    expect(Buffer.from(factor.secretEnc).toString('utf8')).not.toContain(secret);
    expect(crypto.decryptTotpSecret(factor.secretEnc, admin.id)).toBe(secret);

    const wrong = await as(t2, addr).post('/api/v1/auth/mfa/totp/confirm').send({ code: totp(secret!, Date.now() - 10 * 60_000) }).expect(400);
    expect(wrong.body.error.code).toBe('OTP_INVALID');
    const confirmed = await as(t2, addr).post('/api/v1/auth/mfa/totp/confirm').send({ code: totp(secret!) }).expect(200);
    expect(confirmed.body.data.user).toMatchObject({ mfaMethod: 'TOTP', adminAccess: true, hasTotpFactor: true });
    const t3 = cookieFrom(confirmed, SESSION_COOKIE)!;
    expect(t3).not.toBe(t2);
    const s3 = await sessionOf(t3);
    expect(s3.mfaMethod).toBe('TOTP');
    expect(s3.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 12 * 3_600_000);
    const f = await t.prisma.userMfaFactor.findUniqueOrThrow({ where: { id: factor.id } });
    expect(f.confirmedAt).not.toBeNull();
    expect(f.lastUsedStep).not.toBeNull();

    await as(t3, addr).get('/api/v1/admin/__probe/ping').expect(200);
    await as(t2, addr).get('/api/v1/auth/session').expect(401);
    const actions = (await t.prisma.auditLog.findMany({ where: { actorUserId: admin.id }, orderBy: { createdAt: 'asc' } })).map(
      (a) => a.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining(['auth.login', 'auth.mfa.email_verified', 'auth.mfa.totp_setup_started', 'auth.mfa.totp_enrolled']),
    );
  });

  it('re-running the setup replaces the unconfirmed secret', async () => {
    const admin = await createUser(t.prisma, { roles: ['FINANCE_REVIEWER'] });
    const session = await loginAs(t, admin, { mfa: 'EMAIL_OTP' });
    const first = (await session.post('/api/v1/auth/mfa/totp/setup').expect(200)).body.data.secret as string;
    const second = (await session.post('/api/v1/auth/mfa/totp/setup').expect(200)).body.data.secret as string;
    expect(second).not.toBe(first);
    expect(await t.prisma.userMfaFactor.count({ where: { userId: admin.id, revokedAt: null } })).toBe(1);
    await session.post('/api/v1/auth/mfa/totp/confirm').send({ code: totp(first) }).expect(400);
    await session.post('/api/v1/auth/mfa/totp/confirm').send({ code: totp(second) }).expect(200);
  });

  it('admin with an authenticator: login → TOTP step → verify; a replayed code is refused', async () => {
    const admin = await createUser(t.prisma, { roles: ['SUPER_ADMIN'], password: PASSWORD });
    const { secret } = await createTotpFactor(t, admin);
    const a = await login(admin.email);
    expect(a.res.body.data).toMatchObject({ mfaRequired: true, method: 'TOTP', user: { hasTotpFactor: true, adminAccess: false } });
    const denied = await as(a.token, a.addr).get('/api/v1/admin/__probe/ping').expect(403);
    expect(denied.body.error.details.reason).toBe('TOTP_REQUIRED');
    // the email path is only for admins without an authenticator
    expect((await as(a.token, a.addr).post('/api/v1/auth/mfa/email/send').expect(409)).body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect((await as(a.token, a.addr).post('/api/v1/auth/mfa/totp/setup').expect(409)).body.error.code).toBe('INVALID_STATE_TRANSITION');

    const code = totp(secret);
    const ok = await as(a.token, a.addr).post('/api/v1/auth/mfa/totp/verify').send({ code }).expect(200);
    expect(ok.body.data.user).toMatchObject({ mfaMethod: 'TOTP', adminAccess: true });
    const elevated = cookieFrom(ok, SESSION_COOKIE)!;
    await as(elevated, a.addr).get('/api/v1/admin/__probe/ping').expect(200);
    expect(await t.prisma.session.findUniqueOrThrow({ where: { tokenHash: sha256Hex(a.token) } })).toMatchObject({
      revokeReason: 'mfa_rotated',
    });

    const b = await login(admin.email);
    const replay = await as(b.token, b.addr).post('/api/v1/auth/mfa/totp/verify').send({ code }).expect(400);
    expect(replay.body.error.code).toBe('OTP_INVALID');
    await as(b.token, b.addr).get('/api/v1/admin/__probe/ping').expect(403);
  });

  it('throttles repeated wrong authenticator codes', async () => {
    const admin = await createUser(t.prisma, { roles: ['PROGRAM_ADMIN'], password: PASSWORD });
    await createTotpFactor(t, admin);
    const a = await login(admin.email);
    for (let i = 0; i < 5; i++) {
      await as(a.token, a.addr).post('/api/v1/auth/mfa/totp/verify').send({ code: String(100000 + i) }).expect(400);
    }
    const blocked = await as(a.token, a.addr).post('/api/v1/auth/mfa/totp/verify').send({ code: '123456' }).expect(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });

  it('LOGIN_MFA is refused when the account email changed after the session signed in', async () => {
    const admin = await createUser(t.prisma, { roles: ['PROGRAM_ADMIN'], password: PASSWORD });
    const a = await login(admin.email);
    const moved = `moved-${Date.now()}@example.test`;
    // the address changes by any path after this sign-in (e.g. a change finished in another session)
    await t.prisma.user.update({ where: { id: admin.id }, data: { email: moved, emailVerifiedAt: new Date() } });
    const res = await as(a.token, a.addr).post('/api/v1/auth/mfa/email/send').expect(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(await t.prisma.emailChallenge.count({ where: { purpose: 'LOGIN_MFA' } })).toBe(0);
    // a fresh sign-in (which needs the password for the current address) may bootstrap
    const b = await login(moved);
    await as(b.token, b.addr).post('/api/v1/auth/mfa/email/send').expect(200);
  });

  describe('per-account cap on authenticator codes (independent of the client IP)', () => {
    const lockout = () => t.get(TotpLockoutService);
    /** A 6-digit code outside the ±1-step window of `secret`. */
    function wrongCode(secret: string, i: number): string {
      const valid = new Set([-30_000, 0, 30_000].map((d) => totp(secret, Date.now() + d)));
      for (let n = 100_000 + i * 7919; ; n++) {
        const c = String(n % 1_000_000).padStart(6, '0');
        if (!valid.has(c)) return c;
      }
    }
    const emailsTo = async (to: string) =>
      (await t.prisma.outboxMessage.findMany({ where: { topic: 'email.send' } })).filter((m) => (m.payload as { to?: string }).to === to);

    it('10 wrong codes from 10 IPs lock TOTP for the account, revoke the session and notify the owner and Super Admins once', async () => {
      const superAdmin = await factoryAdmin(t.prisma);
      const admin = await createUser(t.prisma, { roles: ['PROGRAM_ADMIN'], password: PASSWORD });
      const { secret } = await createTotpFactor(t, admin);
      const a = await login(admin.email);
      for (let i = 0; i < 9; i++) {
        const r = await as(a.token).post('/api/v1/auth/mfa/totp/verify').send({ code: wrongCode(secret, i) });
        expect(r.status, JSON.stringify(r.body)).toBe(400);
      }
      const locked = await as(a.token).post('/api/v1/auth/mfa/totp/verify').send({ code: wrongCode(secret, 9) }).expect(429);
      expect(locked.body.error).toMatchObject({ code: 'RATE_LIMITED', details: { retryAfterSeconds: 900 } });
      expect(Number(locked.headers['retry-after'])).toBe(900);
      // the guessing session is signed out
      expect(await sessionOf(a.token)).toMatchObject({ revokeReason: 'totp_locked' });
      await as(a.token).get('/api/v1/auth/session').expect(401);

      // even the right code, from a new sign-in on another IP, is refused while locked …
      const b = await login(admin.email);
      expect((await as(b.token).post('/api/v1/auth/mfa/totp/verify').send({ code: totp(secret) }).expect(429)).body.error.code).toBe(
        'RATE_LIMITED',
      );
      // … and so is the authenticator reset of an already verified session
      const verified = await loginAs(t, admin, { mfa: 'TOTP' });
      await verified.withHeaders({ 'X-Forwarded-For': ip() }).post('/api/v1/users/me/mfa/totp/reset').send({ code: totp(secret) }).expect(429);
      expect(await t.prisma.userMfaFactor.count({ where: { userId: admin.id, revokedAt: null } })).toBe(1);

      const subject = (m: { payload: unknown }) => (m.payload as { data: { subject: string } }).data.subject;
      expect((await emailsTo(admin.email)).map(subject)).toEqual(['Security alert: too many incorrect authenticator codes']);
      expect((await emailsTo(superAdmin.email)).map(subject)).toEqual([
        'Security notice: Authenticator verification locked on an admin account',
      ]);
      expect(JSON.stringify((await emailsTo(superAdmin.email))[0]!.payload)).not.toContain(admin.email);
      expect(await t.prisma.auditLog.count({ where: { action: 'auth.mfa.totp_locked', resourceId: admin.id } })).toBe(1);

      // when the lock ends, the next wrong code locks again at once (doubled) without a second notice
      await t.get(RedisService).redis.del(`totp-lockout:v1:user:${admin.id}:block`);
      const c = await login(admin.email);
      const again = await as(c.token).post('/api/v1/auth/mfa/totp/verify').send({ code: wrongCode(secret, 10) }).expect(429);
      expect(again.body.error.details.retryAfterSeconds).toBe(1800);
      expect(await emailsTo(admin.email)).toHaveLength(1);
      expect(await t.prisma.auditLog.count({ where: { action: 'auth.mfa.totp_locked', resourceId: admin.id } })).toBe(1);

      // a correct code after the lock resets the counter
      await t.get(RedisService).redis.del(`totp-lockout:v1:user:${admin.id}:block`);
      const d = await login(admin.email);
      await as(d.token).post('/api/v1/auth/mfa/totp/verify').send({ code: totp(secret) }).expect(200);
      expect(await t.get(RedisService).redis.exists(`totp-lockout:v1:user:${admin.id}:n`)).toBe(0);
    });

    it('wrong enrollment confirmations count against the same per-account cap', async () => {
      const admin = await createUser(t.prisma, { roles: ['FINANCE_REVIEWER'] });
      const session = await loginAs(t, admin, { mfa: 'EMAIL_OTP' });
      const { secret } = (await session.post('/api/v1/auth/mfa/totp/setup').expect(200)).body.data as { secret: string };
      for (let i = 0; i < 9; i++) {
        await session.withHeaders({ 'X-Forwarded-For': ip() }).post('/api/v1/auth/mfa/totp/confirm').send({ code: wrongCode(secret, i) }).expect(400);
      }
      await session.withHeaders({ 'X-Forwarded-For': ip() }).post('/api/v1/auth/mfa/totp/confirm').send({ code: wrongCode(secret, 9) }).expect(429);
      await session.get('/api/v1/auth/session').expect(401);
      expect(await t.prisma.userMfaFactor.count({ where: { userId: admin.id, confirmedAt: { not: null } } })).toBe(0);
      expect(lockout().policy.threshold).toBe(10);
      await lockout().reset(admin.id);
    });
  });

  it('members cannot use the admin MFA endpoints', async () => {
    const member = await createUser(t.prisma, { password: PASSWORD });
    const { res, token, addr } = await login(member.email);
    expect(res.body.data.mfaRequired).toBe(false);
    for (const path of ['email/send', 'totp/setup']) {
      expect((await as(token, addr).post(`/api/v1/auth/mfa/${path}`).expect(403)).body.error.code).toBe('FORBIDDEN');
    }
    expect((await as(token, addr).post('/api/v1/auth/mfa/totp/verify').send({ code: '123456' }).expect(403)).body.error.code).toBe(
      'FORBIDDEN',
    );
    await anon().post('/api/v1/auth/mfa/email/send').expect(401);
  });
});
