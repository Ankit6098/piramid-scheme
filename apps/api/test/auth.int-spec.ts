import { randomInt } from 'node:crypto';
import type { ChallengePurpose } from '@app/shared';
import type { Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../src/common/auth/cookies';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { sha256Hex } from '../src/common/crypto/tokens';
import { RedisService } from '../src/common/redis/redis.service';
import { ScheduledJobsRegistry } from '../src/jobs/scheduler/scheduled-jobs.registry';
import { AuthJobs } from '../src/modules/auth/auth.jobs';
import { createTestApp, type TestApp, type TestClient } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import { createUser, factoryAdmin, loginAs } from './utils/factories';

// ─── helpers ────────────────────────────────────────────────────────────────

const PASSWORD = 'Correct-horse-42';
const ip = () => `198.19.${randomInt(256)}.${randomInt(1, 255)}`;
const uniqueEmail = (tag: string) => `${tag}-${Date.now().toString(36)}-${randomInt(1e9)}@example.test`;

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

describe('auth: registration, verification, login, password reset', () => {
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

  /** Anonymous client with its own client IP (isolates throttle counters between tests). */
  const anon = (addr = ip()): TestClient => t.client().withHeaders({ 'X-Forwarded-For': addr, 'User-Agent': 'vitest-auth' });
  const withSession = (token: string, addr = ip()): TestClient =>
    t.clientWithSession(token).withHeaders({ 'X-Forwarded-For': addr, 'User-Agent': 'vitest-auth' });

  async function openChallenge(email: string, purpose: ChallengePurpose) {
    return t.prisma.emailChallenge.findFirst({
      where: { email, purpose, consumedAt: null, invalidatedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Reads the code the worker would send: decrypts the outbox ciphertext of the open challenge. */
  async function latestCode(email: string, purpose: ChallengePurpose): Promise<{ code: string; challengeId: string }> {
    const ch = await openChallenge(email, purpose);
    if (!ch) throw new Error(`no open ${purpose} challenge for ${email}`);
    const rows = await t.prisma.$queryRaw<Array<{ payload: { codeCiphertext: string } }>>`
      SELECT "payload" FROM "outbox_messages" WHERE "topic" = 'email.otp' AND "payload"->>'challengeId' = ${ch.id}`;
    const msg = rows[0];
    if (!msg) throw new Error('no OTP outbox message');
    return { code: crypto.decryptOtpCode(msg.payload.codeCiphertext, ch.id), challengeId: ch.id };
  }

  const wrongCode = (code: string) => (code === '000000' ? '111111' : '000000');

  function register(client: TestClient, body: { fullName?: string; email: string; password?: string; referralCode?: string }) {
    return client.post('/api/v1/auth/register').send({ fullName: body.fullName ?? 'New Member', password: PASSWORD, ...body });
  }

  async function registerAndVerify(email: string, referralCode?: string) {
    const c = anon();
    await register(c, { email, ...(referralCode ? { referralCode } : {}) }).expect(202);
    const { code } = await latestCode(email, 'EMAIL_VERIFICATION');
    const res = await c.post('/api/v1/auth/verify-email').send({ email, code }).expect(200);
    return { res, token: cookieFrom(res, SESSION_COOKIE)! };
  }

  // ─── registration ─────────────────────────────────────────────────────────

  describe('POST /auth/register', () => {
    it('never creates a user: stores the pending payload on a challenge and emails only a ciphertext', async () => {
      const email = uniqueEmail('reg');
      const res = await register(anon(), { email: `  ${email.toUpperCase()} `, fullName: 'Asha Rao' }).expect(202);
      expect(res.body.data).toMatchObject({ accepted: true, expiresInSeconds: 600, resendAfterSeconds: 60 });

      expect(await t.prisma.user.count({ where: { email } })).toBe(0);
      const ch = await openChallenge(email, 'EMAIL_VERIFICATION');
      expect(ch).toMatchObject({ userId: null, pendingFullName: 'Asha Rao', attempts: 0, maxAttempts: 5 });
      expect(ch!.pendingPasswordHash).toMatch(/^\$argon2id\$/);
      expect(ch!.expiresAt.getTime() - ch!.createdAt.getTime()).toBe(600_000);

      const outbox = await t.prisma.outboxMessage.findMany({ where: { topic: 'email.otp' } });
      expect(outbox).toHaveLength(1);
      const payload = outbox[0]!.payload as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(['challengeId', 'codeCiphertext', 'template']);
      const { code } = await latestCode(email, 'EMAIL_VERIFICATION');
      expect(code).toMatch(/^\d{6}$/);
      expect(JSON.stringify(payload)).not.toContain(code);
      expect(ch!.codeHash).toBe(crypto.otpCodeHash('EMAIL_VERIFICATION', email, code));
      expect(ch!.codeHash).not.toContain(code);
    });

    it('answers identically for an existing account and sends that owner a (de-duplicated) notice instead', async () => {
      const existing = await createUser(t.prisma, { fullName: 'Existing Person' });
      const fresh = uniqueEmail('fresh');
      const a = await register(anon(), { email: fresh });
      const b = await register(anon(), { email: existing.email });
      expect(b.status).toBe(a.status);
      expect(b.body).toEqual(a.body);

      expect(await t.prisma.emailChallenge.count({ where: { email: existing.email } })).toBe(0);
      await register(anon(), { email: existing.email }).expect(202);
      const notices = await t.prisma.outboxMessage.findMany({ where: { topic: 'email.send' } });
      const forOwner = notices.filter((n) => (n.payload as { to?: string }).to === existing.email);
      expect(forOwner).toHaveLength(1);
      expect((forOwner[0]!.payload as { template: string }).template).toBe('registration-attempt-existing-account');
    });

    it('rejects an invalid referral code with REFERRAL_CODE_INVALID and stores nothing', async () => {
      const email = uniqueEmail('badref');
      const res = await register(anon(), { email, referralCode: 'NOPE2345' }).expect(400);
      expect(res.body.error.code).toBe('REFERRAL_CODE_INVALID');
      expect(await t.prisma.emailChallenge.count({ where: { email } })).toBe(0);
    });

    it('validates input (password policy, email format)', async () => {
      const res = await anon()
        .post('/api/v1/auth/register')
        .send({ fullName: 'X Y', email: 'not-an-email', password: 'short' })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      const paths = (res.body.error.details.issues as Array<{ path: string }>).map((i) => i.path);
      expect(paths).toEqual(expect.arrayContaining(['email', 'password']));
      const noDigit = await register(anon(), { email: uniqueEmail('nd'), password: 'onlyletterspassword' }).expect(400);
      expect(noDigit.body.error.details.issues[0].message).toMatch(/digit/);
    });
  });

  // ─── verification ─────────────────────────────────────────────────────────

  describe('POST /auth/verify-email', () => {
    it('creates the ACTIVE verified member, attributes the sponsor at verification and signs in', async () => {
      const sponsor = await createUser(t.prisma, { fullName: 'Sunita Sponsor' });
      const email = uniqueEmail('child');
      const addr = ip();
      const c = anon(addr);
      await register(c, { email, referralCode: ` ${sponsor.referralCode.toLowerCase()} ` }).expect(202);
      expect(await t.prisma.referralRelationship.count({ where: { sponsorUserId: sponsor.id } })).toBe(0);

      const { code, challengeId } = await latestCode(email, 'EMAIL_VERIFICATION');
      const res = await c.post('/api/v1/auth/verify-email').send({ email, code: `${code.slice(0, 3)} ${code.slice(3)}` }).expect(200);
      expect(res.body.data.referral).toEqual({ applied: true, codeNoLongerValid: false });
      expect(res.body.data.user).toMatchObject({
        email,
        fullName: 'New Member',
        emailVerified: true,
        roles: ['MEMBER'],
        permissions: [],
        isAdmin: false,
        adminAccess: false,
        mfaMethod: null,
        hasTotpFactor: false,
      });
      const token = cookieFrom(res, SESSION_COOKIE);
      expect(token).toBeTruthy();
      expect(cookieFrom(res, 'csrf_token')).toBeTruthy();

      const user = await t.prisma.user.findUniqueOrThrow({ where: { email }, include: { roles: { include: { role: true } } } });
      expect(user.status).toBe('ACTIVE');
      expect(user.emailVerifiedAt).not.toBeNull();
      expect(user.roles.map((r) => r.role.key)).toEqual(['MEMBER']);
      const rel = await t.prisma.referralRelationship.findUniqueOrThrow({ where: { childUserId: user.id } });
      expect(rel).toMatchObject({ sponsorUserId: sponsor.id, referralCodeId: sponsor.referralCodeId, source: 'REGISTRATION' });
      expect(rel.registrationIp).toBe(addr);
      expect(rel.registrationUserAgent).toBe('vitest-auth');
      const paths = await t.prisma.referralPath.findMany({ where: { descendantId: user.id }, orderBy: { depth: 'asc' } });
      expect(paths.map((p) => [p.ancestorId, p.depth])).toEqual([
        [user.id, 0],
        [sponsor.id, 1],
      ]);
      expect(await t.prisma.referralCode.count({ where: { userId: user.id, isActive: true } })).toBe(1);

      const ch = await t.prisma.emailChallenge.findUniqueOrThrow({ where: { id: challengeId } });
      expect(ch.consumedAt).not.toBeNull();
      expect(ch).toMatchObject({ userId: user.id, pendingFullName: null, pendingPasswordHash: null, pendingReferralCodeId: null });

      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'user.register', resourceId: user.id } });
      expect(audit.actorUserId).toBe(user.id);
      expect(audit.after).toMatchObject({ sponsorUserId: sponsor.id, referralCodeNoLongerValid: false });
      expect(JSON.stringify(audit.after)).not.toContain(email);

      const session = await withSession(token!).get('/api/v1/auth/session').expect(200);
      expect(session.body.data.user.id).toBe(user.id);
      // the new member can sign in with the password chosen at registration
      await anon().post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
    });

    it('joins without a sponsor (and says so) when the code became invalid before verification', async () => {
      const sponsor = await createUser(t.prisma);
      const email = uniqueEmail('late');
      const c = anon();
      await register(c, { email, referralCode: sponsor.referralCode }).expect(202);
      await t.prisma.referralCode.update({ where: { id: sponsor.referralCodeId }, data: { isActive: false } });
      const { code } = await latestCode(email, 'EMAIL_VERIFICATION');
      const res = await c.post('/api/v1/auth/verify-email').send({ email, code }).expect(200);
      expect(res.body.data.referral).toEqual({ applied: false, codeNoLongerValid: true });
      const user = await t.prisma.user.findUniqueOrThrow({ where: { email } });
      expect(await t.prisma.referralRelationship.count({ where: { childUserId: user.id } })).toBe(0);
      expect(await t.prisma.referralPath.count({ where: { descendantId: user.id } })).toBe(1);
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'user.register', resourceId: user.id } });
      expect(audit.after).toMatchObject({ sponsorUserId: null, referralCodeNoLongerValid: true });
    });

    it('anti-squatting: an attacker registration never attaches; the owner registration replaces it', async () => {
      const attackerSponsor = await createUser(t.prisma, { fullName: 'Attacker Upline' });
      const ownerSponsor = await createUser(t.prisma, { fullName: 'Owner Upline' });
      const victim = uniqueEmail('victim');

      await register(anon(), { email: victim, referralCode: attackerSponsor.referralCode, password: 'Attacker-pass-1' }).expect(202);
      const attackerCode = await latestCode(victim, 'EMAIL_VERIFICATION');
      // nothing is attached (no user exists) until the mailbox owner verifies
      expect(await t.prisma.user.count({ where: { email: victim } })).toBe(0);
      expect(await t.prisma.referralRelationship.count({ where: { sponsorUserId: attackerSponsor.id } })).toBe(0);

      // the owner registers (no cooldown for a newer registration) → the attacker's pending payload is gone
      const owner = anon();
      await register(owner, { email: victim, referralCode: ownerSponsor.referralCode }).expect(202);
      const old = await t.prisma.emailChallenge.findUniqueOrThrow({ where: { id: attackerCode.challengeId } });
      expect(old.invalidatedAt).not.toBeNull();
      expect(old.pendingPasswordHash).toBeNull();
      expect((await owner.post('/api/v1/auth/verify-email').send({ email: victim, code: attackerCode.code })).body.error.code).toBe(
        'OTP_INVALID',
      );

      const ownerCode = await latestCode(victim, 'EMAIL_VERIFICATION');
      await owner.post('/api/v1/auth/verify-email').send({ email: victim, code: ownerCode.code }).expect(200);
      const user = await t.prisma.user.findUniqueOrThrow({ where: { email: victim } });
      const rel = await t.prisma.referralRelationship.findUniqueOrThrow({ where: { childUserId: user.id } });
      expect(rel.sponsorUserId).toBe(ownerSponsor.id);
      expect(await t.prisma.referralRelationship.count({ where: { sponsorUserId: attackerSponsor.id } })).toBe(0);
      expect((await anon().post('/api/v1/auth/login').send({ email: victim, password: 'Attacker-pass-1' })).status).toBe(401);
      await anon().post('/api/v1/auth/login').send({ email: victim, password: PASSWORD }).expect(200);
    });

    it('allows 5 attempts per code: afterwards even the right code is refused', async () => {
      const email = uniqueEmail('attempts');
      const c = anon();
      await register(c, { email }).expect(202);
      const { code, challengeId } = await latestCode(email, 'EMAIL_VERIFICATION');
      for (let i = 0; i < 5; i++) {
        const res = await c.post('/api/v1/auth/verify-email').send({ email, code: wrongCode(code) }).expect(400);
        expect(res.body.error.code).toBe('OTP_INVALID');
      }
      const last = await c.post('/api/v1/auth/verify-email').send({ email, code }).expect(400);
      expect(last.body.error.code).toBe('OTP_INVALID');
      expect((await t.prisma.emailChallenge.findUniqueOrThrow({ where: { id: challengeId } })).attempts).toBe(5);
      expect(await t.prisma.user.count({ where: { email } })).toBe(0);
    });

    it('refuses an expired code and a code that was already used, with the same generic error', async () => {
      const email = uniqueEmail('expiry');
      const c = anon();
      await register(c, { email }).expect(202);
      const { code, challengeId } = await latestCode(email, 'EMAIL_VERIFICATION');
      const now = Date.now();
      await t.prisma.emailChallenge.update({
        where: { id: challengeId },
        data: { createdAt: new Date(now - 20 * 60_000), expiresAt: new Date(now - 10 * 60_000) },
      });
      const expired = await c.post('/api/v1/auth/verify-email').send({ email, code }).expect(400);
      const unknown = await c.post('/api/v1/auth/verify-email').send({ email: uniqueEmail('nobody'), code }).expect(400);
      expect(expired.body.error.code).toBe('OTP_INVALID');
      expect(expired.body.error.message).toBe(unknown.body.error.message);

      // single use
      const other = uniqueEmail('single');
      const { res } = await registerAndVerify(other);
      expect(res.status).toBe(200);
      const used = await t.prisma.emailChallenge.findFirstOrThrow({ where: { email: other, consumedAt: { not: null } } });
      expect(used).toBeTruthy();
      const again = await anon().post('/api/v1/auth/verify-email').send({ email: other, code: '123456' }).expect(400);
      expect(again.body.error.code).toBe('OTP_INVALID');
      expect(await t.prisma.user.count({ where: { email: other } })).toBe(1);
    });

    it('cumulative cap: 10 failed attempts in 24 h block verification and new codes; the owner is told once', async () => {
      const email = uniqueEmail('cap');
      const c = anon();
      const fail = async (n: number) => {
        const { code } = await latestCode(email, 'EMAIL_VERIFICATION');
        for (let i = 0; i < n; i++) await c.post('/api/v1/auth/verify-email').send({ email, code: wrongCode(code) }).expect(400);
      };
      await register(c, { email }).expect(202);
      await fail(5);
      await register(c, { email }).expect(202);
      await fail(4);
      await register(c, { email }).expect(202);
      const { code } = await latestCode(email, 'EMAIL_VERIFICATION');
      await fail(1); // 10th failure → blocked
      const blocked = await c.post('/api/v1/auth/verify-email').send({ email, code }).expect(400);
      expect(blocked.body.error.code).toBe('OTP_INVALID');
      expect(await t.prisma.user.count({ where: { email } })).toBe(0);

      const before = await t.prisma.emailChallenge.count({ where: { email } });
      const res = await register(c, { email }).expect(202);
      expect(res.body.data.accepted).toBe(true);
      expect(await t.prisma.emailChallenge.count({ where: { email } })).toBe(before);
      expect(await openChallenge(email, 'EMAIL_VERIFICATION')).toBeNull();

      const alerts = (await t.prisma.outboxMessage.findMany({ where: { topic: 'email.send' } })).filter(
        (m) => (m.payload as { to?: string; data?: { subject?: string } }).to === email,
      );
      expect(alerts).toHaveLength(1);
      expect((alerts[0]!.payload as { data: { subject: string } }).data.subject).toMatch(/too many incorrect codes/i);
    });
  });

  describe('POST /auth/register/resend', () => {
    it('is generic: silent during the 60 s cooldown, then a new code replaces the old one', async () => {
      const email = uniqueEmail('resend');
      const c = anon();
      await register(c, { email }).expect(202);
      const first = await latestCode(email, 'EMAIL_VERIFICATION');

      const inCooldown = await c.post('/api/v1/auth/register/resend').send({ email }).expect(202);
      const unknown = await c.post('/api/v1/auth/register/resend').send({ email: uniqueEmail('nobody') }).expect(202);
      expect(inCooldown.body).toEqual(unknown.body);
      expect(await t.prisma.emailChallenge.count({ where: { email } })).toBe(1);

      await t.prisma.emailChallenge.update({ where: { id: first.challengeId }, data: { createdAt: new Date(Date.now() - 61_000) } });
      await c.post('/api/v1/auth/register/resend').send({ email }).expect(202);
      const second = await latestCode(email, 'EMAIL_VERIFICATION');
      expect(second.challengeId).not.toBe(first.challengeId);
      const ch = await t.prisma.emailChallenge.findUniqueOrThrow({ where: { id: second.challengeId } });
      expect(ch).toMatchObject({ sendCount: 2, pendingFullName: 'New Member' });
      expect((await t.prisma.emailChallenge.findUniqueOrThrow({ where: { id: first.challengeId } })).invalidatedAt).not.toBeNull();

      if (first.code !== second.code) {
        await c.post('/api/v1/auth/verify-email').send({ email, code: first.code }).expect(400);
      }
      await c.post('/api/v1/auth/verify-email').send({ email, code: second.code }).expect(200);
    });

    it('stops after 5 codes per hour', async () => {
      const email = uniqueEmail('hourly');
      const c = anon();
      for (let i = 0; i < 5; i++) {
        await register(c, { email }).expect(202);
        const ch = await openChallenge(email, 'EMAIL_VERIFICATION');
        await t.prisma.emailChallenge.update({ where: { id: ch!.id }, data: { createdAt: new Date(Date.now() - (50 - i) * 60_000) } });
      }
      expect(await t.prisma.emailChallenge.count({ where: { email } })).toBe(5);
      await c.post('/api/v1/auth/register/resend').send({ email }).expect(202);
      expect(await t.prisma.emailChallenge.count({ where: { email } })).toBe(5);
    });
  });

  // ─── login / logout / session ─────────────────────────────────────────────

  describe('POST /auth/login', () => {
    it('gives unknown emails and wrong passwords the same 401; status errors only after a correct password', async () => {
      const user = await createUser(t.prisma, { password: PASSWORD });
      const suspended = await createUser(t.prisma, { password: PASSWORD, status: 'SUSPENDED' });
      const unknown = await anon().post('/api/v1/auth/login').send({ email: uniqueEmail('ghost'), password: PASSWORD }).expect(401);
      const wrong = await anon().post('/api/v1/auth/login').send({ email: user.email, password: 'Wrong-password-1' }).expect(401);
      const suspendedWrong = await anon().post('/api/v1/auth/login').send({ email: suspended.email, password: 'Wrong-password-1' }).expect(401);
      for (const r of [unknown, wrong, suspendedWrong]) {
        expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
        expect(r.body.error.message).toBe(unknown.body.error.message);
        expect(cookieFrom(r, SESSION_COOKIE)).toBeNull();
      }
      const blocked = await anon().post('/api/v1/auth/login').send({ email: suspended.email, password: PASSWORD }).expect(403);
      expect(blocked.body.error.code).toBe('ACCOUNT_SUSPENDED');
      expect(cookieFrom(blocked, SESSION_COOKIE)).toBeNull();
    });

    it('backs off after 5 failures for (email, IP) — even the right password — without locking other IPs', async () => {
      const user = await createUser(t.prisma, { password: PASSWORD });
      const attacker = anon();
      for (let i = 0; i < 5; i++) {
        await attacker.post('/api/v1/auth/login').send({ email: user.email, password: `Wrong-password-${i}` }).expect(401);
      }
      const res = await attacker.post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD }).expect(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      // the owner on another network is not locked out
      await anon().post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD }).expect(200);
    });

    it('creates a member session, ends a session presented with the request, and logout revokes it', async () => {
      const user = await createUser(t.prisma, { password: PASSWORD, fullName: 'Meena Member' });
      const first = await anon().post('/api/v1/auth/login').send({ email: user.email.toUpperCase(), password: PASSWORD }).expect(200);
      expect(first.body.data).toMatchObject({ mfaRequired: false, user: { id: user.id, mfaMethod: null, adminAccess: false } });
      const token1 = cookieFrom(first, SESSION_COOKIE)!;
      const s1 = await t.prisma.session.findUniqueOrThrow({ where: { tokenHash: sha256Hex(token1) } });
      expect(s1.expiresAt.getTime() - s1.createdAt.getTime()).toBe(168 * 3_600_000);
      expect(s1.userAgent).toBe('vitest-auth');
      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).lastLoginAt).not.toBeNull();
      expect(await t.prisma.auditLog.count({ where: { action: 'auth.login', actorUserId: user.id } })).toBe(1);

      const second = await withSession(token1).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD }).expect(200);
      const token2 = cookieFrom(second, SESSION_COOKIE)!;
      expect(token2).not.toBe(token1);
      expect((await t.prisma.session.findUniqueOrThrow({ where: { id: s1.id } })).revokedAt).not.toBeNull();
      await withSession(token1).get('/api/v1/auth/session').expect(401);

      const me = await withSession(token2).get('/api/v1/auth/session').expect(200);
      expect(me.body.data.user).toMatchObject({ id: user.id, fullName: 'Meena Member', roles: ['MEMBER'] });
      expect(me.body.data.user).not.toHaveProperty('passwordHash');

      await withSession(token2).post('/api/v1/auth/logout').expect(200);
      const s2 = await t.prisma.session.findUniqueOrThrow({ where: { tokenHash: sha256Hex(token2) } });
      expect(s2.revokeReason).toBe('logout');
      await withSession(token2).get('/api/v1/auth/session').expect(401);
      // logout without a session is harmless
      await anon().post('/api/v1/auth/logout').expect(200);
    });

    it('GET /auth/session is 401 without a session and clears a dead cookie', async () => {
      await anon().get('/api/v1/auth/session').expect(401);
      const res = await withSession('x'.repeat(43)).get('/api/v1/auth/session').expect(401);
      expect(String(res.headers['set-cookie'])).toContain(`${SESSION_COOKIE}=;`);
    });
  });

  // ─── password reset ───────────────────────────────────────────────────────

  describe('password reset', () => {
    it('is generic, resets with the emailed code and revokes every session', async () => {
      const user = await createUser(t.prisma, { password: PASSWORD, fullName: 'Ravi Reset' });
      const s1 = await loginAs(t, user);
      const s2 = await loginAs(t, user);
      const known = await anon().post('/api/v1/auth/password/forgot').send({ email: user.email }).expect(202);
      const unknown = await anon().post('/api/v1/auth/password/forgot').send({ email: uniqueEmail('nobody') }).expect(202);
      expect(known.body).toEqual(unknown.body);

      const { code } = await latestCode(user.email, 'PASSWORD_RESET');
      const weak = await anon().post('/api/v1/auth/password/reset').send({ email: user.email, code, newPassword: 'weak' }).expect(400);
      expect(weak.body.error.code).toBe('VALIDATION_FAILED');
      await anon()
        .post('/api/v1/auth/password/reset')
        .send({ email: user.email, code: wrongCode(code), newPassword: 'Brand-new-pass-7' })
        .expect(400);
      const res = await anon()
        .post('/api/v1/auth/password/reset')
        .send({ email: user.email, code, newPassword: 'Brand-new-pass-7' })
        .expect(200);
      expect(res.body.data).toEqual({ passwordReset: true });
      expect(cookieFrom(res, SESSION_COOKIE)).toBeNull();

      for (const s of [s1, s2]) {
        const row = await t.prisma.session.findUniqueOrThrow({ where: { id: s.sessionId } });
        expect(row.revokeReason).toBe('password_reset');
        await s.get('/api/v1/auth/session').expect(401);
      }
      expect((await anon().post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD })).status).toBe(401);
      await anon().post('/api/v1/auth/login').send({ email: user.email, password: 'Brand-new-pass-7' }).expect(200);
      // the code is single use
      await anon().post('/api/v1/auth/password/reset').send({ email: user.email, code, newPassword: 'Another-pass-8' }).expect(400);

      const notice = (await t.prisma.outboxMessage.findMany({ where: { topic: 'email.send' } })).find(
        (m) => (m.payload as { to?: string }).to === user.email,
      );
      expect((notice!.payload as { data: { subject: string } }).data.subject).toBe('Your password was changed');
      expect(await t.prisma.auditLog.count({ where: { action: 'user.password.reset', resourceId: user.id } })).toBe(1);
    });

    it('is disabled for admin roles: same 202, no code, every SUPER_ADMIN notified', async () => {
      const superAdmin = await factoryAdmin(t.prisma);
      const admin = await createUser(t.prisma, { roles: ['FINANCE_REVIEWER'], password: PASSWORD });
      const member = await createUser(t.prisma, { password: PASSWORD });
      const a = await anon().post('/api/v1/auth/password/forgot').send({ email: admin.email }).expect(202);
      const m = await anon().post('/api/v1/auth/password/forgot').send({ email: member.email }).expect(202);
      expect(a.body).toEqual(m.body);
      expect(await t.prisma.emailChallenge.count({ where: { email: admin.email } })).toBe(0);
      expect(await t.prisma.emailChallenge.count({ where: { email: member.email } })).toBe(1);

      const emails = await t.prisma.outboxMessage.findMany({ where: { topic: 'email.send' } });
      expect(emails.some((e) => (e.payload as { to?: string }).to === admin.email)).toBe(false);
      const toSuper = emails.filter((e) => (e.payload as { to?: string }).to === superAdmin.email);
      expect(toSuper).toHaveLength(1);
      expect(JSON.stringify(toSuper[0]!.payload)).not.toContain(admin.email);
      expect(await t.prisma.auditLog.count({ where: { action: 'auth.password_reset.blocked_admin', resourceId: admin.id } })).toBe(1);
    });
  });

  // ─── outbox hygiene & housekeeping ────────────────────────────────────────

  it('no outbox payload ever contains a plaintext code', async () => {
    const member = await createUser(t.prisma, { password: PASSWORD });
    const email = uniqueEmail('sweep');
    await register(anon(), { email }).expect(202);
    await anon().post('/api/v1/auth/password/forgot').send({ email: member.email }).expect(202);
    const codes = [(await latestCode(email, 'EMAIL_VERIFICATION')).code, (await latestCode(member.email, 'PASSWORD_RESET')).code];
    const rows = await t.prisma.outboxMessage.findMany();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      const text = JSON.stringify(row.payload);
      for (const code of codes) expect(text).not.toContain(code);
      expect(text).not.toMatch(/"(code|otp)"\s*:/i);
    }
  });

  it('cleanup jobs scrub stale pending registrations and are registered', async () => {
    const email = uniqueEmail('stale');
    await register(anon(), { email }).expect(202);
    const jobs = t.get(AuthJobs);
    expect((await jobs.cleanupChallenges()).scrubbed).toBe(0);
    const result = await jobs.cleanupChallenges(new Date(Date.now() + 2 * 86_400_000));
    expect(result.scrubbed).toBe(1);
    const ch = await t.prisma.emailChallenge.findFirstOrThrow({ where: { email } });
    expect(ch).toMatchObject({ pendingFullName: null, pendingPasswordHash: null });
    // a scrubbed pending registration can no longer be re-sent
    await t.prisma.emailChallenge.update({ where: { id: ch.id }, data: { createdAt: new Date(Date.now() - 61_000) } });
    await anon().post('/api/v1/auth/register/resend').send({ email }).expect(202);
    expect(await t.prisma.emailChallenge.count({ where: { email } })).toBe(1);

    const registry = t.get(ScheduledJobsRegistry);
    expect(registry.get('auth-challenge-cleanup')).toBeDefined();
    expect(registry.get('auth-session-cleanup')).toBeDefined();
    const user = await createUser(t.prisma);
    const old = await loginAs(t, user);
    await t.prisma.session.update({ where: { id: old.sessionId }, data: { revokedAt: new Date(), revokeReason: 'logout' } });
    expect(await jobs.cleanupSessions(new Date(Date.now() + 31 * 86_400_000))).toBeGreaterThanOrEqual(1);
    expect(await t.prisma.session.count({ where: { id: old.sessionId } })).toBe(0);
  });
});
