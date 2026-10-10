import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OutboxHandlerRegistry, PermanentOutboxError } from '../src/jobs/outbox/outbox-handler.registry';
import { FraudSignalsService } from '../src/modules/referrals/fraud-signals.service';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import { createProgram, createUser, factoryAdmin, loginAs, type TestUser } from './utils/factories';

describe('flags: shared-IP heuristic and admin flag management', () => {
  let t: TestApp;
  let fraud: FraudSignalsService;

  beforeAll(async () => {
    t = await createTestApp();
    fraud = t.get(FraudSignalsService);
  });
  beforeEach(async () => {
    await resetDatabase();
    await factoryAdmin(t.prisma);
  });
  afterAll(async () => {
    await t.close();
    await disconnectTestPrisma();
  });

  async function recruits(sponsor: TestUser, ip: string | null, n: number): Promise<TestUser[]> {
    const out: TestUser[] = [];
    for (let i = 0; i < n; i += 1) out.push(await createUser(t.prisma, { sponsor, registrationIp: ip }));
    return out;
  }

  describe('SHARED_IP_REGISTRATIONS', () => {
    it('raises one OPEN flag on the sponsor from the third attribution and dedupes redeliveries', async () => {
      const sponsor = await createUser(t.prisma, { fullName: 'Suspicious Sponsor' });
      const [r1, r2, r3, r4] = await recruits(sponsor, '198.51.100.23', 4);

      expect(await fraud.evaluateRegistration(r1!.id)).toMatchObject({ outcome: 'BELOW_THRESHOLD', count: 1 });
      expect(await fraud.evaluateRegistration(r2!.id)).toMatchObject({ outcome: 'BELOW_THRESHOLD', count: 2 });
      const raised = await fraud.evaluateRegistration(r3!.id);
      expect(raised).toMatchObject({ outcome: 'FLAG_RAISED', count: 3 });

      // Redelivery of the same message and the next attribution update the same flag.
      expect(await fraud.evaluateRegistration(r3!.id)).toMatchObject({ outcome: 'FLAG_UPDATED', flagId: raised.flagId });
      expect(await fraud.evaluateRegistration(r4!.id)).toMatchObject({ outcome: 'FLAG_UPDATED', count: 4, flagId: raised.flagId });

      const flags = await t.prisma.memberFlag.findMany();
      expect(flags).toHaveLength(1);
      expect(flags[0]).toMatchObject({
        userId: sponsor.id,
        kind: 'SHARED_IP_REGISTRATIONS',
        status: 'OPEN',
        dedupeKey: `SHARED_IP:${sponsor.id}:198.51.100.23`,
        createdById: null,
      });
      expect(flags[0]?.details).toContain('4 registrations');
      const audit = await t.prisma.auditLog.findMany({ where: { action: 'flag.raise' } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorUserId: null, actorRoles: ['SYSTEM'], resourceId: raised.flagId });
    });

    it('keeps IPs and sponsors apart and ignores attributions without an IP', async () => {
      const s1 = await createUser(t.prisma);
      const s2 = await createUser(t.prisma);
      const a = await recruits(s1, '203.0.113.1', 2);
      const b = await recruits(s1, '203.0.113.2', 1);
      const c = await recruits(s2, '203.0.113.1', 1);
      const none = await recruits(s1, null, 3);
      for (const u of [...a, ...b, ...c]) {
        expect((await fraud.evaluateRegistration(u.id)).outcome).toBe('BELOW_THRESHOLD');
      }
      expect((await fraud.evaluateRegistration(none[2]!.id)).outcome).toBe('SKIPPED');
      expect((await fraud.evaluateRegistration(randomUUID())).outcome).toBe('SKIPPED');
      expect(await t.prisma.memberFlag.count()).toBe(0);
    });

    it('does not re-raise attributions an admin already reviewed, but flags new ones', async () => {
      const admin = await createUser(t.prisma, { roles: ['SUPER_ADMIN'] });
      const sponsor = await createUser(t.prisma);
      const first = await recruits(sponsor, '192.0.2.44', 3);
      const raised = await fraud.evaluateRegistration(first[2]!.id);
      const client = await loginAs(t, admin);
      await client
        .post(`/api/v1/admin/flags/${raised.flagId}/resolve`)
        .send({ status: 'DISMISSED', resolution: 'Family members sharing one router' })
        .expect(200);

      expect((await fraud.evaluateRegistration(first[2]!.id)).outcome).toBe('ALREADY_REVIEWED');
      const [later] = await recruits(sponsor, '192.0.2.44', 1);
      expect((await fraud.evaluateRegistration(later!.id)).outcome).toBe('FLAG_RAISED');
      expect(await t.prisma.memberFlag.count({ where: { status: 'OPEN' } })).toBe(1);
    });

    it('is wired to the outbox topic and rejects malformed payloads permanently', async () => {
      const handler = t.get(OutboxHandlerRegistry).get('fraud.registration-attributed');
      expect(handler).toBeDefined();
      const view = (payload: unknown) => ({ id: randomUUID(), topic: 'fraud.registration-attributed', payload, attempts: 1, maxAttempts: 8, createdAt: new Date() });
      await expect(handler!.handle(view({ childUserId: 'nope' }) as never)).rejects.toBeInstanceOf(PermanentOutboxError);
      const sponsor = await createUser(t.prisma);
      const users = await recruits(sponsor, '198.51.100.99', 3);
      await handler!.handle(view({ childUserId: users[2]!.id }) as never);
      expect(await t.prisma.memberFlag.count({ where: { userId: sponsor.id, status: 'OPEN' } })).toBe(1);
    });
  });

  describe('admin API', () => {
    async function setup() {
      const admin = await createUser(t.prisma, { fullName: 'Flag Admin', roles: ['SUPER_ADMIN'] });
      const subject = await createUser(t.prisma, { fullName: 'Flagged Member' });
      return { admin, subject, client: await loginAs(t, admin) };
    }

    it('raises a manual report, lists it with filters and resolves it once', async () => {
      const { admin, subject, client } = await setup();
      const created = await client
        .post('/api/v1/admin/flags')
        .send({ userId: subject.id, details: 'Reported by support: repeated fake sign-ups' })
        .expect(201);
      expect(created.body.data).toMatchObject({
        kind: 'MANUAL_REPORT',
        status: 'OPEN',
        user: { id: subject.id, fullName: 'Flagged Member', status: 'ACTIVE' },
        createdBy: { id: admin.id, fullName: 'Flag Admin' },
        resolvedBy: null,
      });
      const id = created.body.data.id as string;
      expect(JSON.stringify(created.body)).not.toContain(subject.email);

      const open = await client.get('/api/v1/admin/flags?status=OPEN&kind=MANUAL_REPORT').expect(200);
      expect(open.body.data.map((f: { id: string }) => f.id)).toEqual([id]);
      const none = await client.get('/api/v1/admin/flags?status=RESOLVED').expect(200);
      expect(none.body.data).toEqual([]);
      const byUser = await client.get(`/api/v1/admin/flags?userId=${subject.id}`).expect(200);
      expect(byUser.body.data).toHaveLength(1);

      const resolved = await client
        .post(`/api/v1/admin/flags/${id}/resolve`)
        .send({ status: 'RESOLVED', resolution: 'Accounts verified by phone; all genuine' })
        .expect(200);
      expect(resolved.body.data).toMatchObject({ status: 'RESOLVED', resolvedBy: { id: admin.id } });
      expect(resolved.body.data.resolvedAt).toEqual(expect.any(String));

      const again = await client
        .post(`/api/v1/admin/flags/${id}/resolve`)
        .send({ status: 'DISMISSED', resolution: 'Trying to resolve twice here' })
        .expect(409);
      expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');

      const actions = await t.prisma.auditLog.findMany({ where: { resourceId: id }, orderBy: { createdAt: 'asc' } });
      expect(actions.map((a) => a.action)).toEqual(['flag.create', 'flag.resolve']);
    });

    it('paginates newest first', async () => {
      const { subject, client } = await setup();
      for (let i = 0; i < 3; i += 1) {
        await client.post('/api/v1/admin/flags').send({ userId: subject.id, details: `Manual report number ${i}` }).expect(201);
      }
      const p1 = await client.get('/api/v1/admin/flags?limit=2').expect(200);
      expect(p1.body.data.map((f: { details: string }) => f.details)).toEqual(['Manual report number 2', 'Manual report number 1']);
      const p2 = await client.get(`/api/v1/admin/flags?limit=2&cursor=${p1.body.page.nextCursor}`).expect(200);
      expect(p2.body.data.map((f: { details: string }) => f.details)).toEqual(['Manual report number 0']);
      expect(p2.body.page.nextCursor).toBeNull();
    });

    it('never lets the subject resolve a flag about themselves', async () => {
      const { admin, client } = await setup();
      const other = await createUser(t.prisma, { roles: ['SUPER_ADMIN'] });
      const created = await (await loginAs(t, other))
        .post('/api/v1/admin/flags')
        .send({ userId: admin.id, details: 'Admin account under review' })
        .expect(201);
      const res = await client
        .post(`/api/v1/admin/flags/${created.body.data.id}/resolve`)
        .send({ status: 'DISMISSED', resolution: 'This is about me, dismissing' })
        .expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('validates input and requires flags:manage', async () => {
      const { subject, client } = await setup();
      await client.post('/api/v1/admin/flags').send({ userId: subject.id, details: 'short' }).expect(400);
      await client.post('/api/v1/admin/flags').send({ userId: randomUUID(), details: 'Unknown member report' }).expect(404);
      await client.get('/api/v1/admin/flags?status=WHATEVER').expect(400);
      await client.post(`/api/v1/admin/flags/${randomUUID()}/resolve`).send({ status: 'RESOLVED', resolution: 'Nothing to resolve here' }).expect(404);
      await client.post(`/api/v1/admin/flags/${randomUUID()}/resolve`).send({ status: 'OPEN', resolution: 'Nothing to resolve here' }).expect(400);

      const program = await createProgram(t.prisma);
      const pa = await createUser(t.prisma, { roles: ['PROGRAM_ADMIN'], programScopes: [program.id] });
      const fin = await createUser(t.prisma, { roles: ['FINANCE_REVIEWER'] });
      for (const u of [pa, fin, subject]) {
        await (await loginAs(t, u)).get('/api/v1/admin/flags').expect(403);
      }
    });
  });
});
