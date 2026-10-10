import type { AdminMemberDetailDto, AdminMemberListItemDto, ApiPage } from '@app/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../src/common/auth/auth-context';
import { RequestContext } from '../src/common/context/request-context';
import { AdminMembersService } from '../src/modules/admin/admin-members.service';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import {
  createEnrollment,
  createEvent,
  createPolicy,
  createProgram,
  createUser,
  factoryAdmin,
  loginAs,
  postRewardForTest,
  processEventForTest,
  type TestUser,
} from './utils/factories';

const REASON = 'Reason recorded for the audit trail';

describe('admin members', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await t?.close();
    await disconnectTestPrisma();
  });

  /**
   * P1 (INR): anita > rahul > priya (all enrolled in P1); P2 (USD): kiran (sponsored by rahul) enrolled.
   * Sale by priya in P1 → rahul L1 100.00 POSTED, anita L2 50.00 PENDING.
   * Sale by kiran in P2 → rahul L1 30.00 POSTED (USD).
   */
  async function fixture() {
    const admin = await factoryAdmin(t.prisma);
    // Approver ≠ recorder (the factory admin records ADMIN_MANUAL sales; SoD is enforced by the DB).
    const finance = await createUser(t.prisma, { fullName: 'Farhan Finance', roles: ['FINANCE_REVIEWER'] });
    const reviewer = finance;
    const p1 = await createProgram(t.prisma, { currencyCode: 'INR' });
    const p2 = await createProgram(t.prisma, { currencyCode: 'USD' });
    const pol1 = await createPolicy(t.prisma, { programId: p1.id });
    const pol2 = await createPolicy(t.prisma, { programId: p2.id });
    const anita = await createUser(t.prisma, { fullName: 'Anita Sharma', email: 'anita.sharma@example.test' });
    const rahul = await createUser(t.prisma, { fullName: 'Rahul Verma', email: 'rahul@verma.example.test', sponsor: anita });
    const priya = await createUser(t.prisma, { fullName: 'Priya Nair', sponsor: rahul });
    const kiran = await createUser(t.prisma, { fullName: 'Kiran 50%_Off', sponsor: rahul });
    for (const u of [anita, rahul, priya]) await createEnrollment(t.prisma, { userId: u.id, programId: p1.id });
    await createEnrollment(t.prisma, { userId: kiran.id, programId: p2.id });

    const e1 = await createEvent(t.prisma, { programId: p1.id, subjectUserId: priya.id, amountMinor: 100_000n });
    const r1 = await processEventForTest(t.prisma, {
      eventId: e1.id,
      policyVersionId: pol1.id,
      rewards: [
        { recipientUserId: rahul.id, level: 1, amountMinor: 10_000n },
        { recipientUserId: anita.id, level: 2, amountMinor: 5_000n },
      ],
    });
    await postRewardForTest(t.prisma, r1.rewards[0]!.id, reviewer.id);
    const e2 = await createEvent(t.prisma, { programId: p2.id, subjectUserId: kiran.id, amountMinor: 30_000n });
    const r2 = await processEventForTest(t.prisma, {
      eventId: e2.id,
      policyVersionId: pol2.id,
      rewards: [{ recipientUserId: rahul.id, level: 1, amountMinor: 3_000n }],
    });
    await postRewardForTest(t.prisma, r2.rewards[0]!.id, reviewer.id);

    const programAdmin = await createUser(t.prisma, { fullName: 'Pooja Admin', roles: ['PROGRAM_ADMIN'], programScopes: [p1.id] });
    await t.prisma.memberFlag.create({ data: { userId: rahul.id, kind: 'MANUAL_REPORT', details: 'Check shared device' } });
    return { admin, p1, p2, anita, rahul, priya, kiran, programAdmin, finance };
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>;
  let f: Fixture;

  beforeEach(async () => {
    await resetDatabase();
    f = await fixture();
  });

  const listAs = async (user: TestUser, query = '') => {
    const res = await (await loginAs(t, user)).get(`/api/v1/admin/members${query}`).expect(200);
    return res.body as ApiPage<AdminMemberListItemDto>;
  };

  describe('GET /admin/members', () => {
    it('searches by name or email fragment (case-insensitive) and escapes wildcards', async () => {
      expect((await listAs(f.admin, '?q=sharma')).data.map((m) => m.id)).toEqual([f.anita.id]);
      expect((await listAs(f.admin, '?q=VERMA.EXAMPLE')).data.map((m) => m.id)).toEqual([f.rahul.id]);
      expect((await listAs(f.admin, '?q=50%25_off')).data.map((m) => m.id)).toEqual([f.kiran.id]);
      expect((await listAs(f.admin, '?q=%25')).data.map((m) => m.id)).toEqual([f.kiran.id]);
      expect((await listAs(f.admin, '?q=nobody-matches')).data).toEqual([]);
    });

    it('returns admin-visible fields (email, roles, counts) without secrets', async () => {
      const page = await listAs(f.admin, '?q=rahul');
      expect(page.data[0]).toEqual({
        id: f.rahul.id,
        fullName: 'Rahul Verma',
        email: 'rahul@verma.example.test',
        status: 'ACTIVE',
        emailVerified: true,
        roles: ['MEMBER'],
        activeEnrollments: 1,
        openFlags: 1,
        createdAt: expect.any(String),
        lastLoginAt: null,
      });
      expect(JSON.stringify(page)).not.toMatch(/passwordHash|tokenHash|codeHash/);
    });

    it('filters by status, role and program, and paginates with a cursor', async () => {
      await t.prisma.user.update({ where: { id: f.priya.id }, data: { status: 'SUSPENDED', suspendedAt: new Date(), suspensionReason: 'x' } });
      expect((await listAs(f.admin, '?status=SUSPENDED')).data.map((m) => m.id)).toEqual([f.priya.id]);
      expect((await listAs(f.admin, '?role=FINANCE_REVIEWER')).data.map((m) => m.id)).toEqual([f.finance.id]);
      expect(new Set((await listAs(f.admin, `?programId=${f.p1.id}`)).data.map((m) => m.id))).toEqual(
        new Set([f.anita.id, f.rahul.id, f.priya.id]),
      );

      const all = await listAs(f.admin, '?limit=100');
      const client = await loginAs(t, f.admin);
      const first = (await client.get('/api/v1/admin/members?limit=3').expect(200)).body as ApiPage<AdminMemberListItemDto>;
      expect(first.data).toHaveLength(3);
      expect(first.page.nextCursor).toEqual(expect.any(String));
      const second = (await client.get(`/api/v1/admin/members?limit=3&cursor=${first.page.nextCursor}`).expect(200)).body as ApiPage<AdminMemberListItemDto>;
      expect(second.data.map((m) => m.id)).toEqual(all.data.slice(3, 6).map((m) => m.id));
      await client.get('/api/v1/admin/members?cursor=not-a-cursor!').expect(400);
      await client.get('/api/v1/admin/members?status=BOGUS').expect(400);
    });

    it('limits a PROGRAM_ADMIN to members enrolled in assigned programs', async () => {
      const page = await listAs(f.programAdmin);
      expect(new Set(page.data.map((m) => m.id))).toEqual(new Set([f.anita.id, f.rahul.id, f.priya.id]));
      expect(page.data.every((m) => m.openFlags === 0)).toBe(true);
      expect((await listAs(f.programAdmin, '?q=kiran')).data).toEqual([]);
      const res = await (await loginAs(t, f.programAdmin)).get(`/api/v1/admin/members?programId=${f.p2.id}`).expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('requires members:read and an admin session', async () => {
      await (await loginAs(t, f.priya)).get('/api/v1/admin/members').expect(403);
      await t.client().get('/api/v1/admin/members').expect(401);
    });
  });

  describe('GET /admin/members/:id', () => {
    it('returns profile, roles, sponsor, team counts, enrollments, reward summary and flags', async () => {
      const res = await (await loginAs(t, f.admin)).get(`/api/v1/admin/members/${f.rahul.id}`).expect(200);
      const d = res.body.data as AdminMemberDetailDto;
      expect(d).toMatchObject({
        id: f.rahul.id,
        email: 'rahul@verma.example.test',
        status: 'ACTIVE',
        roles: [{ role: 'MEMBER', grantedBy: null }],
        programScopes: [],
        hasTotpFactor: false,
        referralCode: f.rahul.referralCode,
        sponsor: { id: f.anita.id, fullName: 'Anita Sharma', email: 'anita.sharma@example.test' },
        team: { directReferrals: 2, totalDescendants: 2 },
        can: { suspend: true, reactivate: false, changeRoles: true },
      });
      expect(d.enrollments.map((e) => e.program.id).sort()).toEqual([f.p1.id]);
      expect(d.enrollments[0]).toMatchObject({ status: 'ACTIVE', priceMinor: '0', program: { currencyCode: 'INR' } });
      expect(d.rewardSummary).toEqual([
        { rewardUnit: 'MONEY', currencyCode: 'INR', earnedMinor: '10000', pendingMinor: '0', reversedMinor: '0' },
        { rewardUnit: 'MONEY', currencyCode: 'USD', earnedMinor: '3000', pendingMinor: '0', reversedMinor: '0' },
      ]);
      expect(d.openFlags).toEqual([expect.objectContaining({ kind: 'MANUAL_REPORT', status: 'OPEN' })]);

      const anita = (await (await loginAs(t, f.admin)).get(`/api/v1/admin/members/${f.anita.id}`).expect(200)).body.data as AdminMemberDetailDto;
      expect(anita.rewardSummary).toEqual([{ rewardUnit: 'MONEY', currencyCode: 'INR', earnedMinor: '0', pendingMinor: '5000', reversedMinor: '0' }]);
      expect(anita.team).toEqual({ directReferrals: 1, totalDescendants: 3 });
    });

    it('scopes a PROGRAM_ADMIN view: own programs only, no flags, 404 outside scope', async () => {
      const client = await loginAs(t, f.programAdmin);
      const d = (await client.get(`/api/v1/admin/members/${f.rahul.id}`).expect(200)).body.data as AdminMemberDetailDto;
      expect(d.rewardSummary).toEqual([{ rewardUnit: 'MONEY', currencyCode: 'INR', earnedMinor: '10000', pendingMinor: '0', reversedMinor: '0' }]);
      expect(d.openFlags).toBeNull();
      expect(d.can).toEqual({ suspend: false, reactivate: false, changeRoles: false });
      await client.get(`/api/v1/admin/members/${f.kiran.id}`).expect(404);
      await client.get(`/api/v1/admin/members/${f.admin.id}`).expect(404);
    });

    it('404 for an unknown id, 400 for a malformed one', async () => {
      const client = await loginAs(t, f.admin);
      await client.get('/api/v1/admin/members/00000000-0000-4000-8000-000000000000').expect(404);
      await client.get('/api/v1/admin/members/nope').expect(400);
    });
  });

  describe('suspend / reactivate', () => {
    it('suspends with a reason, revokes the member sessions and audits', async () => {
      const memberClient = await loginAs(t, f.priya);
      await memberClient.get('/api/v1/users/me/notifications').expect(200);

      const res = await (await loginAs(t, f.admin))
        .post(`/api/v1/admin/members/${f.priya.id}/suspend`)
        .send({ reason: REASON })
        .expect(200);
      expect(res.body.data).toEqual({ id: f.priya.id, status: 'SUSPENDED', sessionsRevoked: 1 });

      const user = await t.prisma.user.findUniqueOrThrow({ where: { id: f.priya.id } });
      expect(user).toMatchObject({ status: 'SUSPENDED', suspensionReason: REASON });
      expect(user.suspendedAt).toBeInstanceOf(Date);
      expect(await t.prisma.session.count({ where: { userId: f.priya.id, revokedAt: null } })).toBe(0);
      await memberClient.get('/api/v1/users/me/notifications').expect(401);

      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'member.suspend', resourceId: f.priya.id } });
      expect(audit).toMatchObject({ actorUserId: f.admin.id, resourceType: 'user', reason: REASON, before: { status: 'ACTIVE' } });
      expect(audit.after).toMatchObject({ status: 'SUSPENDED', sessionsRevoked: 1 });
    });

    it('rejects self, invalid state, short reasons and callers without members:write', async () => {
      const admin = await loginAs(t, f.admin);
      const self = await admin.post(`/api/v1/admin/members/${f.admin.id}/suspend`).send({ reason: REASON }).expect(403);
      expect(self.body.error.message).toMatch(/your own account/);
      const short = await admin.post(`/api/v1/admin/members/${f.priya.id}/suspend`).send({ reason: 'short' }).expect(400);
      expect(short.body.error.code).toBe('VALIDATION_FAILED');
      const notSuspended = await admin.post(`/api/v1/admin/members/${f.priya.id}/reactivate`).send({ reason: REASON }).expect(409);
      expect(notSuspended.body.error.code).toBe('INVALID_STATE_TRANSITION');

      await admin.post(`/api/v1/admin/members/${f.priya.id}/suspend`).send({ reason: REASON }).expect(200);
      const again = await admin.post(`/api/v1/admin/members/${f.priya.id}/suspend`).send({ reason: REASON }).expect(409);
      expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');

      for (const user of [f.finance, f.programAdmin]) {
        const res = await (await loginAs(t, user)).post(`/api/v1/admin/members/${f.anita.id}/suspend`).send({ reason: REASON }).expect(403);
        expect(res.body.error.details.missingPermissions).toEqual(['members:write']);
      }
    });

    it('requires CSRF for the mutation', async () => {
      const res = await (await loginAs(t, f.admin)).withoutCsrf().post(`/api/v1/admin/members/${f.priya.id}/suspend`).send({ reason: REASON }).expect(403);
      expect(res.body.error.code).toBe('CSRF_FAILED');
    });

    it('only a SUPER_ADMIN may suspend an administrator', async () => {
      // Give FINANCE_REVIEWER members:write to exercise the rule (role permissions are read per request).
      const [role, perm] = await Promise.all([
        t.prisma.role.findUniqueOrThrow({ where: { key: 'FINANCE_REVIEWER' } }),
        t.prisma.permission.findUniqueOrThrow({ where: { key: 'members:write' } }),
      ]);
      await t.prisma.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
      const finance = await loginAs(t, f.finance);
      const res = await finance.post(`/api/v1/admin/members/${f.programAdmin.id}/suspend`).send({ reason: REASON }).expect(403);
      expect(res.body.error.message).toMatch(/Only a Super Admin/);
      await finance.post(`/api/v1/admin/members/${f.priya.id}/suspend`).send({ reason: REASON }).expect(200);
      await (await loginAs(t, f.admin)).post(`/api/v1/admin/members/${f.programAdmin.id}/suspend`).send({ reason: REASON }).expect(200);
    });

    it('reactivates a suspended member, audits and notifies them', async () => {
      const admin = await loginAs(t, f.admin);
      await admin.post(`/api/v1/admin/members/${f.priya.id}/suspend`).send({ reason: REASON }).expect(200);
      const res = await admin.post(`/api/v1/admin/members/${f.priya.id}/reactivate`).send({ reason: REASON }).expect(200);
      expect(res.body.data).toEqual({ id: f.priya.id, status: 'ACTIVE', sessionsRevoked: 0 });
      const user = await t.prisma.user.findUniqueOrThrow({ where: { id: f.priya.id } });
      expect(user).toMatchObject({ status: 'ACTIVE', suspendedAt: null, suspensionReason: null });
      expect(await t.prisma.auditLog.count({ where: { action: 'member.reactivate', resourceId: f.priya.id } })).toBe(1);
      const outbox = await t.prisma.outboxMessage.findMany({ where: { topic: 'notification.create' } });
      expect(outbox.map((m) => m.payload)).toContainEqual(expect.objectContaining({ userId: f.priya.id, type: 'account.reactivated' }));
    });

    it('keeps one active SUPER_ADMIN when two super admins suspend each other concurrently', async () => {
      await resetDatabase();
      const a = await createUser(t.prisma, { roles: ['SUPER_ADMIN'] });
      const b = await createUser(t.prisma, { roles: ['SUPER_ADMIN'] });
      const [ca, cb] = await Promise.all([loginAs(t, a), loginAs(t, b)]);
      const results = await Promise.all([
        ca.post(`/api/v1/admin/members/${b.id}/suspend`).send({ reason: REASON }),
        cb.post(`/api/v1/admin/members/${a.id}/suspend`).send({ reason: REASON }),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      const loser = results.find((r) => r.status !== 200)!;
      expect([401, 403, 409]).toContain(loser.status);
      if (loser.status === 409) {
        expect(loser.body.error).toMatchObject({ code: 'INVARIANT_VIOLATION', details: { rule: 'LAST_SUPER_ADMIN' } });
        expect(loser.body.error.message).toMatch(/At least one active Super Admin/);
      }
      const active = await t.prisma.user.count({ where: { status: 'ACTIVE', roles: { some: { role: { key: 'SUPER_ADMIN' } } } } });
      expect(active).toBe(1);
    });
  });

  describe('PUT /admin/members/:id/roles', () => {
    it('grants and revokes roles with grantedById, revokes the member sessions, audits and notifies', async () => {
      const memberClient = await loginAs(t, f.priya);
      const admin = await loginAs(t, f.admin);
      const res = await admin
        .put(`/api/v1/admin/members/${f.priya.id}/roles`)
        .send({ roles: ['FINANCE_REVIEWER', 'MEMBER'], reason: REASON })
        .expect(200);
      expect(res.body.data).toEqual({ roles: ['FINANCE_REVIEWER', 'MEMBER'], granted: ['FINANCE_REVIEWER'], revoked: [], sessionsRevoked: 1 });
      const grant = await t.prisma.userRole.findFirstOrThrow({ where: { userId: f.priya.id, role: { key: 'FINANCE_REVIEWER' } } });
      expect(grant.grantedById).toBe(f.admin.id);
      await memberClient.get('/api/v1/users/me/notifications').expect(401);
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'member.roles.update', resourceId: f.priya.id } });
      expect(audit.before).toEqual({ roles: ['MEMBER'] });
      expect(audit.after).toMatchObject({ roles: ['FINANCE_REVIEWER', 'MEMBER'], granted: ['FINANCE_REVIEWER'], revoked: [] });

      const revoke = await admin.put(`/api/v1/admin/members/${f.priya.id}/roles`).send({ roles: [], reason: REASON }).expect(200);
      expect(revoke.body.data).toMatchObject({ roles: ['MEMBER'], granted: [], revoked: ['FINANCE_REVIEWER'] });
      const detail = (await admin.get(`/api/v1/admin/members/${f.priya.id}`).expect(200)).body.data as AdminMemberDetailDto;
      expect(detail.roles.map((r) => r.role)).toEqual(['MEMBER']);
      const outbox = await t.prisma.outboxMessage.findMany({ where: { topic: 'notification.create' } });
      expect(outbox.filter((m) => (m.payload as { type?: string }).type === 'account.roles_changed')).toHaveLength(2);
    });

    it('is a no-op (no audit, sessions kept) when nothing changes', async () => {
      const memberClient = await loginAs(t, f.priya);
      const res = await (await loginAs(t, f.admin)).put(`/api/v1/admin/members/${f.priya.id}/roles`).send({ roles: ['MEMBER'], reason: REASON }).expect(200);
      expect(res.body.data).toEqual({ roles: ['MEMBER'], granted: [], revoked: [], sessionsRevoked: 0 });
      expect(await t.prisma.auditLog.count({ where: { action: 'member.roles.update' } })).toBe(0);
      await memberClient.get('/api/v1/users/me/notifications').expect(200);
    });

    it('refuses self-changes and callers without roles:assign; validates the body', async () => {
      const admin = await loginAs(t, f.admin);
      const self = await admin.put(`/api/v1/admin/members/${f.admin.id}/roles`).send({ roles: ['MEMBER'], reason: REASON }).expect(403);
      expect(self.body.error.message).toMatch(/your own roles/);
      await admin.put(`/api/v1/admin/members/${f.priya.id}/roles`).send({ roles: ['OWNER'], reason: REASON }).expect(400);
      await admin.put(`/api/v1/admin/members/${f.priya.id}/roles`).send({ roles: ['MEMBER'] }).expect(400);
      for (const user of [f.finance, f.programAdmin]) {
        const res = await (await loginAs(t, user)).put(`/api/v1/admin/members/${f.priya.id}/roles`).send({ roles: ['SUPER_ADMIN'], reason: REASON }).expect(403);
        expect(res.body.error.details.missingPermissions).toEqual(['roles:assign']);
      }
    });

    it('can remove SUPER_ADMIN from another super admin while one remains', async () => {
      const other = await createUser(t.prisma, { roles: ['SUPER_ADMIN'] });
      const res = await (await loginAs(t, f.admin)).put(`/api/v1/admin/members/${other.id}/roles`).send({ roles: [], reason: REASON }).expect(200);
      expect(res.body.data.revoked).toEqual(['SUPER_ADMIN']);
    });

    it('translates the last-SUPER_ADMIN rule into a friendly 409 (pre-check and DB commit check)', async () => {
      const service = t.get(AdminMembersService);
      // A SUPER_ADMIN actor whose own account was suspended meanwhile (stale session context).
      const ghost = await createUser(t.prisma, { roles: ['SUPER_ADMIN'], status: 'SUSPENDED' });
      const auth = {
        userId: ghost.id,
        roles: ['MEMBER', 'SUPER_ADMIN'],
        permissions: new Set(['roles:assign', 'members:write']),
        programScopes: [],
      } as unknown as AuthContext;
      const run = <T>(fn: () => Promise<T>) => RequestContext.run({ auth }, fn);

      await expect(run(() => service.updateRoles(auth, f.admin.id, { roles: [], reason: REASON }))).rejects.toMatchObject({
        code: 'INVARIANT_VIOLATION',
        httpStatus: 409,
        details: { rule: 'LAST_SUPER_ADMIN' },
      });

      // Without the pre-check the deferred DB trigger fails the COMMIT; that error is translated too.
      vi.spyOn(service as unknown as { assertAnotherActiveSuperAdmin: () => Promise<void> }, 'assertAnotherActiveSuperAdmin').mockResolvedValue();
      await expect(run(() => service.suspend(auth, f.admin.id, REASON))).rejects.toMatchObject({
        code: 'INVARIANT_VIOLATION',
        details: { rule: 'LAST_SUPER_ADMIN' },
      });
      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: f.admin.id } })).status).toBe('ACTIVE');
      expect(await t.prisma.auditLog.count({ where: { action: 'member.suspend' } })).toBe(0);
    });
  });
});
