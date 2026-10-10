import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ReferralsService } from '../src/modules/referrals/referrals.service';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import { createEnrollment, createProgram, createUser, factoryAdmin, loginAs } from './utils/factories';

const DOWNLINE_KEYS = [
  'attributedAt',
  'childCount',
  'depth',
  'displayName',
  'hasEligibleEnrollment',
  'id',
  'joinedAt',
  'statusBucket',
].sort();

describe('referrals: codes, sponsor, direct referrals', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ env: { APP_PUBLIC_URL: 'https://refer.example.test' } });
  });
  beforeEach(async () => {
    await resetDatabase();
    await factoryAdmin(t.prisma);
  });
  afterAll(async () => {
    await t.close();
    await disconnectTestPrisma();
  });

  describe('POST /referrals/validate', () => {
    it('accepts an active code (normalized) and reveals only the display name', async () => {
      const owner = await createUser(t.prisma, { fullName: 'Anita Kumari Sharma' });
      const res = await t
        .client()
        .post('/api/v1/referrals/validate')
        .send({ code: ` ${owner.referralCode.toLowerCase().slice(0, 4)}-${owner.referralCode.toLowerCase().slice(4)} ` })
        .expect(200);
      expect(res.body).toEqual({ data: { valid: true, sponsorDisplayName: 'Anita S.' } });
    });

    it('answers the same for unknown, malformed and suspended-owner codes', async () => {
      const owner = await createUser(t.prisma, { fullName: 'Rahul Verma' });
      await t.prisma.user.update({
        where: { id: owner.id },
        data: { status: 'SUSPENDED', suspendedAt: new Date(), suspensionReason: 'test' },
      });
      for (const code of ['ZZZZ2345', '!!', owner.referralCode]) {
        const res = await t.client().post('/api/v1/referrals/validate').send({ code }).expect(200);
        expect(res.body).toEqual({ data: { valid: false } });
      }
    });

    it('validates the body and still requires the CSRF pair', async () => {
      await t.client().post('/api/v1/referrals/validate').send({}).expect(400);
      const res = await t.client().withoutCsrf().post('/api/v1/referrals/validate').send({ code: 'ABCD2345' }).expect(403);
      expect(res.body.error.code).toBe('CSRF_FAILED');
    });

    it('is rate limited per IP', async () => {
      const limited = await createTestApp();
      try {
        const c = limited.client();
        for (let i = 0; i < 20; i += 1) await c.post('/api/v1/referrals/validate').send({ code: 'ABCD2345' }).expect(200);
        const res = await c.post('/api/v1/referrals/validate').send({ code: 'ABCD2345' }).expect(429);
        expect(res.body.error.code).toBe('RATE_LIMITED');
      } finally {
        await limited.close();
      }
    });
  });

  describe('GET /users/me/referral-code', () => {
    it('returns the code and the public registration link', async () => {
      const me = await createUser(t.prisma);
      const res = await (await loginAs(t, me)).get('/api/v1/users/me/referral-code').expect(200);
      expect(res.body.data).toEqual({
        code: me.referralCode,
        link: `https://refer.example.test/register?ref=${me.referralCode}`,
      });
    });

    it('allocates a new code when the member has no active one', async () => {
      const me = await createUser(t.prisma);
      await t.prisma.referralCode.updateMany({ where: { userId: me.id }, data: { isActive: false } });
      const res = await (await loginAs(t, me)).get('/api/v1/users/me/referral-code').expect(200);
      expect(res.body.data.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
      expect(res.body.data.code).not.toBe(me.referralCode);
      expect(await t.prisma.referralCode.count({ where: { userId: me.id, isActive: true } })).toBe(1);
    });

    it('requires a session', async () => {
      await t.client().get('/api/v1/users/me/referral-code').expect(401);
    });
  });

  describe('GET /users/me/parent', () => {
    it('is null for a member without a sponsor', async () => {
      const root = await createUser(t.prisma);
      const res = await (await loginAs(t, root)).get('/api/v1/users/me/parent').expect(200);
      expect(res.body).toEqual({ data: null });
    });

    it('shows sponsor + upline with display names only (no ids, no emails)', async () => {
      const anita = await createUser(t.prisma, { fullName: 'Anita Sharma' });
      const rahul = await createUser(t.prisma, { fullName: 'Rahul Verma', sponsor: anita });
      const priya = await createUser(t.prisma, { fullName: 'Priya Nair', sponsor: rahul });

      const res = await (await loginAs(t, priya)).get('/api/v1/users/me/parent').expect(200);
      const data = res.body.data;
      expect(data.sponsor).toMatchObject({ displayName: 'Rahul V.', attributionSource: 'REGISTRATION' });
      expect(Date.parse(data.sponsor.attributedAt)).not.toBeNaN();
      expect(data.ancestors.map((a: { displayName: string; depth: number }) => [a.displayName, a.depth])).toEqual([
        ['Rahul V.', 1],
        ['Anita S.', 2],
      ]);
      expect(data.hasMoreAncestors).toBe(false);
      const json = JSON.stringify(res.body);
      for (const secret of [anita.id, rahul.id, anita.email, rahul.email, 'Sharma', 'Verma']) {
        expect(json).not.toContain(secret);
      }
    });

    it('caps the upline at 10 levels', async () => {
      let sponsor = await createUser(t.prisma);
      for (let i = 0; i < 11; i += 1) sponsor = await createUser(t.prisma, { sponsor });
      const me = await createUser(t.prisma, { sponsor });
      const res = await (await loginAs(t, me)).get('/api/v1/users/me/parent').expect(200);
      expect(res.body.data.ancestors).toHaveLength(10);
      expect(res.body.data.hasMoreAncestors).toBe(true);
    });
  });

  describe('GET /users/me/referrals', () => {
    it('lists direct referrals newest first with privacy-filtered fields and cursor pagination', async () => {
      const me = await createUser(t.prisma, { fullName: 'Sponsor Person' });
      const a = await createUser(t.prisma, { fullName: 'Asha Rao', sponsor: me });
      const b = await createUser(t.prisma, { fullName: 'Bala Krishnan', sponsor: me });
      const c = await createUser(t.prisma, { fullName: 'Chitra Iyer', sponsor: me });
      await createUser(t.prisma, { sponsor: a }); // grandchild: not a direct referral
      const program = await createProgram(t.prisma);
      await createEnrollment(t.prisma, { userId: b.id, programId: program.id });

      const client = await loginAs(t, me);
      const p1 = await client.get('/api/v1/users/me/referrals?limit=2').expect(200);
      expect(p1.body.data.map((r: { id: string }) => r.id)).toEqual([c.id, b.id]);
      expect(Object.keys(p1.body.data[0]).sort()).toEqual(DOWNLINE_KEYS);
      expect(p1.body.data[1]).toMatchObject({
        displayName: 'Bala K.',
        depth: 1,
        statusBucket: 'ACTIVE',
        hasEligibleEnrollment: true,
        childCount: 0,
      });
      expect(p1.body.page.nextCursor).toEqual(expect.any(String));

      const p2 = await client.get(`/api/v1/users/me/referrals?limit=2&cursor=${p1.body.page.nextCursor}`).expect(200);
      expect(p2.body.data.map((r: { id: string }) => r.id)).toEqual([a.id]);
      expect(p2.body.data[0]).toMatchObject({ childCount: 1, hasEligibleEnrollment: false });
      expect(p2.body.page.nextCursor).toBeNull();
      const json = JSON.stringify([p1.body, p2.body]);
      for (const secret of [a.email, b.email, c.email, 'Krishnan', 'Iyer']) expect(json).not.toContain(secret);
    });

    it('filters by status bucket and rejects tampered cursors', async () => {
      const me = await createUser(t.prisma);
      const active = await createUser(t.prisma, { sponsor: me });
      const suspended = await createUser(t.prisma, { sponsor: me });
      await t.prisma.user.update({
        where: { id: suspended.id },
        data: { status: 'SUSPENDED', suspendedAt: new Date(), suspensionReason: 'test' },
      });
      const client = await loginAs(t, me);
      const inactive = await client.get('/api/v1/users/me/referrals?status=INACTIVE').expect(200);
      expect(inactive.body.data.map((r: { id: string; statusBucket: string }) => [r.id, r.statusBucket])).toEqual([
        [suspended.id, 'INACTIVE'],
      ]);
      const act = await client.get('/api/v1/users/me/referrals?status=ACTIVE').expect(200);
      expect(act.body.data.map((r: { id: string }) => r.id)).toEqual([active.id]);
      await client.get('/api/v1/users/me/referrals?cursor=not-a-cursor!').expect(400);
      await client.get('/api/v1/users/me/referrals?status=SUSPENDED').expect(400);
    });
  });

  describe('fraud signal enqueue at registration', () => {
    async function register(sponsorCode: string, ip: string | null) {
      const referrals = t.get(ReferralsService);
      const id = randomUUID();
      await t.prisma.$transaction(async (tx) => {
        await tx.user.create({
          data: { id, email: `new-${id}@example.test`, fullName: 'New Member', status: 'ACTIVE', emailVerifiedAt: new Date() },
        });
        const resolved = await referrals.resolveCodeForRegistration(tx, sponsorCode);
        await referrals.attachNewMember(tx, { userId: id, ...resolved, registrationIp: ip, registrationUserAgent: 'vitest' });
      });
      return id;
    }

    it('enqueues fraud.registration-attributed (member id only) for a sponsored registration with an IP', async () => {
      const sponsor = await createUser(t.prisma);
      const withIp = await register(sponsor.referralCode, '203.0.113.9');
      await register(sponsor.referralCode, null);
      const rows = await t.prisma.outboxMessage.findMany({ where: { topic: 'fraud.registration-attributed' } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload).toEqual({ childUserId: withIp });
      expect(rows[0]?.dedupeKey).toBe(`fraud-attribution:${withIp}`);
    });
  });
});
