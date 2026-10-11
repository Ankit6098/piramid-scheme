import type { AdminMemberDetailDto, AdminMemberListItemDto, AdminMemberPasswordResetResultDto, ApiPage } from '@app/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../src/common/auth/auth-context';
import { RequestContext } from '../src/common/context/request-context';
import { CryptoService } from '../src/common/crypto/crypto.service';
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
        sponsor: { id: f.anita.id, displayName: 'Anita S.', fullName: 'Anita Sharma', email: 'anita.sharma@example.test', inScope: true },
        team: { directReferrals: 2, totalDescendants: 2 },
        can: { suspend: true, reactivate: false, changeRoles: true, sendPasswordReset: true },
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
      expect(d.can).toEqual({ suspend: false, reactivate: false, changeRoles: false, sendPasswordReset: false });
      await client.get(`/api/v1/admin/members/${f.kiran.id}`).expect(404);
      await client.get(`/api/v1/admin/members/${f.admin.id}`).expect(404);
      // the in-scope sponsor (anita is enrolled in P1) is shown in full
      expect(d.sponsor).toEqual({
        id: f.anita.id,
        displayName: 'Anita S.',
        fullName: 'Anita Sharma',
        email: 'anita.sharma@example.test',
        inScope: true,
      });
    });

    it('never shows a PROGRAM_ADMIN an out-of-scope sponsor identity or programs outside their scope', async () => {
      // Oscar is enrolled nowhere (outside Pooja's scope) and sponsors Mira, who is enrolled in P1.
      const oscar = await createUser(t.prisma, { fullName: 'Oscar Outside Wilde', email: 'oscar@outside.example.test' });
      const mira = await createUser(t.prisma, { fullName: 'Mira Inside', sponsor: oscar, roles: ['PROGRAM_ADMIN'], programScopes: [f.p1.id, f.p2.id] });
      await createEnrollment(t.prisma, { userId: mira.id, programId: f.p1.id });

      const scoped = (await (await loginAs(t, f.programAdmin)).get(`/api/v1/admin/members/${mira.id}`).expect(200)).body
        .data as AdminMemberDetailDto;
      expect(scoped.sponsor).toEqual({ id: oscar.id, displayName: 'Oscar W.', fullName: null, email: null, inScope: false });
      expect(JSON.stringify(scoped)).not.toContain('oscar@outside.example.test');
      expect(JSON.stringify(scoped)).not.toContain('Outside');
      expect(scoped.programScopes.map((p) => p.id)).toEqual([f.p1.id]);
      expect(JSON.stringify(scoped)).not.toContain(f.p2.id);

      // a SUPER_ADMIN sees everything
      const full = (await (await loginAs(t, f.admin)).get(`/api/v1/admin/members/${mira.id}`).expect(200)).body.data as AdminMemberDetailDto;
      expect(full.sponsor).toEqual({
        id: oscar.id,
        displayName: 'Oscar W.',
        fullName: 'Oscar Outside Wilde',
        email: 'oscar@outside.example.test',
        inScope: true,
      });
      expect(full.programScopes.map((p) => p.id).sort()).toEqual([f.p1.id, f.p2.id].sort());
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

  describe('POST /admin/members/:id/password-reset', () => {
    const NEW_PASSWORD = 'Fresh-admin-pass-9';

    async function openResetChallenge(email: string) {
      return t.prisma.emailChallenge.findFirst({
        where: { email, purpose: 'PASSWORD_RESET', consumedAt: null, invalidatedAt: null },
        orderBy: { createdAt: 'desc' },
      });
    }

    /** The code the worker would send: decrypts the outbox ciphertext of the open challenge. */
    async function resetCode(email: string): Promise<string> {
      const ch = await openResetChallenge(email);
      if (!ch) throw new Error(`no open PASSWORD_RESET challenge for ${email}`);
      const rows = await t.prisma.$queryRaw<Array<{ payload: { codeCiphertext: string } }>>`
        SELECT "payload" FROM "outbox_messages" WHERE "topic" = 'email.otp' AND "payload"->>'challengeId' = ${ch.id}`;
      return t.get(CryptoService).decryptOtpCode(rows[0]!.payload.codeCiphertext, ch.id);
    }

    const emailsTo = async (to: string) =>
      (await t.prisma.outboxMessage.findMany({ where: { topic: 'email.send' }, orderBy: { createdAt: 'asc' } }))
        .map((m) => m.payload as { to: string; data: { subject: string; paragraphs: string[] } })
        .filter((p) => p.to === to);

    it('emails an admin account a code despite the self-service block, signs it out, notifies Super Admins and audits; the owner completes the reset', async () => {
      const otherSuper = await createUser(t.prisma, { fullName: 'Second Super', roles: ['SUPER_ADMIN'] });
      const financeSession = await loginAs(t, f.finance);
      await financeSession.get('/api/v1/auth/session').expect(200);
      const admin = await loginAs(t, f.admin);

      const res = await admin.post(`/api/v1/admin/members/${f.finance.id}/password-reset`).send({ reason: REASON }).expect(200);
      const body = res.body.data as AdminMemberPasswordResetResultDto;
      expect(body).toMatchObject({ id: f.finance.id, sessionsRevoked: 1 });
      expect(body.sentTo).not.toBe(f.finance.email);
      expect(body.sentTo).toContain('***');
      expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);

      // Code bound to the issuing SUPER_ADMIN session; the member is signed out everywhere.
      const ch = await openResetChallenge(f.finance.email);
      expect(ch).toMatchObject({ userId: f.finance.id, sessionId: admin.sessionId, attempts: 0 });
      const revoked = await t.prisma.session.findUniqueOrThrow({ where: { id: financeSession.sessionId } });
      expect(revoked.revokeReason).toBe('admin_password_reset');
      await financeSession.get('/api/v1/auth/session').expect(401);
      // The password itself is unchanged until the code is used.
      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: f.finance.id } })).passwordChangedAt).toBeNull();

      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'member.password_reset.send', resourceId: f.finance.id } });
      expect(audit).toMatchObject({ actorUserId: f.admin.id, resourceType: 'user', reason: REASON });
      expect(audit.after).toMatchObject({ challengeId: ch!.id, sentTo: body.sentTo, adminAccount: true, sessionsRevoked: 1 });
      expect(JSON.stringify(audit.after)).not.toContain(f.finance.email);

      // Owner: the code (OTP outbox, ciphertext only) + an explanatory notice. Every SUPER_ADMIN (incl. the actor) is told.
      const toOwner = await emailsTo(f.finance.email);
      expect(toOwner.map((e) => e.data.subject)).toEqual(['An administrator started a password reset for your account']);
      for (const superAdmin of [f.admin, otherSuper]) {
        const notices = await emailsTo(superAdmin.email);
        expect(notices.map((e) => e.data.subject)).toEqual(['Security notice: Password reset sent to an admin account']);
        expect(notices[0]!.data.paragraphs.join(' ')).toContain(REASON);
        expect(JSON.stringify(notices[0])).not.toContain(f.finance.email);
      }
      const inApp = (await t.prisma.outboxMessage.findMany({ where: { topic: 'notification.create' } })).map(
        (m) => m.payload as { userId: string; type: string },
      );
      expect(inApp).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ userId: f.finance.id, type: 'security.password_reset_started' }),
          expect.objectContaining({ userId: otherSuper.id, type: 'security.admin_account' }),
          expect.objectContaining({ userId: f.admin.id, type: 'security.admin_account' }),
        ]),
      );

      // The owner finishes on the normal reset page — accepted for an admin account because a SUPER_ADMIN issued it.
      const code = await resetCode(f.finance.email);
      await t
        .client()
        .post('/api/v1/auth/password/reset')
        .send({ email: f.finance.email, code, newPassword: NEW_PASSWORD })
        .expect(200);
      const login = await t.client().post('/api/v1/auth/login').send({ email: f.finance.email, password: NEW_PASSWORD }).expect(200);
      expect(login.body.data.mfaRequired).toBe(true);
      const done = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'user.password.reset', resourceId: f.finance.id } });
      expect(done.after).toEqual({ adminInitiated: true, initiatedByUserId: f.admin.id });
      expect((await emailsTo(otherSuper.email)).map((e) => e.data.subject)).toContain(
        'Security notice: Admin account password reset completed',
      );
    });

    it('accepts a code for an admin account only when an ACTIVE Super Admin (still) stands behind it', async () => {
      // (a) a self-service code issued while the account was a plain member, then the member became an admin
      const promoted = await createUser(t.prisma, { fullName: 'Promoted Later' });
      await t.client().post('/api/v1/auth/password/forgot').send({ email: promoted.email }).expect(202);
      const selfServiceCode = await resetCode(promoted.email);
      const role = await t.prisma.role.findUniqueOrThrow({ where: { key: 'PROGRAM_ADMIN' } });
      await t.prisma.userRole.create({ data: { userId: promoted.id, roleId: role.id, grantedById: f.admin.id } });
      const refused = await t
        .client()
        .post('/api/v1/auth/password/reset')
        .send({ email: promoted.email, code: selfServiceCode, newPassword: NEW_PASSWORD })
        .expect(400);
      expect(refused.body.error.code).toBe('OTP_INVALID');
      expect((await t.prisma.user.findUniqueOrThrow({ where: { id: promoted.id } })).passwordChangedAt).toBeNull();

      // (b) issued by a SUPER_ADMIN who lost the role before the owner used the code
      const issuer = await createUser(t.prisma, { fullName: 'Soon Demoted', roles: ['SUPER_ADMIN'] });
      await (await loginAs(t, issuer)).post(`/api/v1/admin/members/${f.programAdmin.id}/password-reset`).send({ reason: REASON }).expect(200);
      const code = await resetCode(f.programAdmin.email);
      await t.prisma.userRole.deleteMany({ where: { userId: issuer.id, role: { key: 'SUPER_ADMIN' } } });
      await t
        .client()
        .post('/api/v1/auth/password/reset')
        .send({ email: f.programAdmin.email, code, newPassword: NEW_PASSWORD })
        .expect(400);
      expect(await t.prisma.auditLog.count({ where: { action: 'user.password.reset' } })).toBe(0);
    });

    it('works for a plain member too, and enforces the code limits without side effects when refused', async () => {
      const admin = await loginAs(t, f.admin);
      await admin.post(`/api/v1/admin/members/${f.priya.id}/password-reset`).send({ reason: REASON }).expect(200);
      const memberSession = await loginAs(t, f.priya);

      const again = await admin.post(`/api/v1/admin/members/${f.priya.id}/password-reset`).send({ reason: REASON }).expect(429);
      expect(again.body.error.code).toBe('OTP_COOLDOWN');
      expect(Number(again.headers['retry-after'])).toBeGreaterThan(0);
      // Refused → rolled back: the new session survives, no second code, no second audit entry.
      await memberSession.get('/api/v1/auth/session').expect(200);
      expect(await t.prisma.emailChallenge.count({ where: { email: f.priya.email, purpose: 'PASSWORD_RESET' } })).toBe(1);
      expect(await t.prisma.auditLog.count({ where: { action: 'member.password_reset.send' } })).toBe(1);

      const code = await resetCode(f.priya.email);
      await t.client().post('/api/v1/auth/password/reset').send({ email: f.priya.email, code, newPassword: NEW_PASSWORD }).expect(200);
      await memberSession.get('/api/v1/auth/session').expect(401);
      await t.client().post('/api/v1/auth/login').send({ email: f.priya.email, password: NEW_PASSWORD }).expect(200);
      const done = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'user.password.reset', resourceId: f.priya.id } });
      expect(done.after).toEqual({ adminInitiated: true, initiatedByUserId: f.admin.id });
    });

    it('is Super Admin only, never yourself, ACTIVE accounts only; validates the reason and needs CSRF', async () => {
      const path = (id: string) => `/api/v1/admin/members/${id}/password-reset`;
      for (const user of [f.finance, f.programAdmin]) {
        const res = await (await loginAs(t, user)).post(path(f.priya.id)).send({ reason: REASON }).expect(403);
        expect(res.body.error.details.missingPermissions).toEqual(expect.arrayContaining(['members:write']));
      }
      // Even with both permissions granted to another role, the role check holds.
      const role = await t.prisma.role.findUniqueOrThrow({ where: { key: 'FINANCE_REVIEWER' } });
      const perms = await t.prisma.permission.findMany({ where: { key: { in: ['members:write', 'roles:assign'] } } });
      await t.prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })) });
      const notSuper = await (await loginAs(t, f.finance)).post(path(f.priya.id)).send({ reason: REASON }).expect(403);
      expect(notSuper.body.error.message).toMatch(/Only a Super Admin/);

      const admin = await loginAs(t, f.admin);
      const self = await admin.post(path(f.admin.id)).send({ reason: REASON }).expect(403);
      expect(self.body.error.message).toMatch(/your own account/);
      const short = await admin.post(path(f.priya.id)).send({ reason: 'short' }).expect(400);
      expect(short.body.error.code).toBe('VALIDATION_FAILED');
      await admin.post(path('00000000-0000-4000-8000-000000000000')).send({ reason: REASON }).expect(404);
      const csrf = await admin.withoutCsrf().post(path(f.priya.id)).send({ reason: REASON }).expect(403);
      expect(csrf.body.error.code).toBe('CSRF_FAILED');

      await admin.post(`/api/v1/admin/members/${f.priya.id}/suspend`).send({ reason: REASON }).expect(200);
      const suspended = await admin.post(path(f.priya.id)).send({ reason: REASON }).expect(409);
      expect(suspended.body.error.code).toBe('INVALID_STATE_TRANSITION');
      const detail = (await admin.get(`/api/v1/admin/members/${f.priya.id}`).expect(200)).body.data as AdminMemberDetailDto;
      expect(detail.can.sendPasswordReset).toBe(false);
      const selfDetail = (await admin.get(`/api/v1/admin/members/${f.admin.id}`).expect(200)).body.data as AdminMemberDetailDto;
      expect(selfDetail.can.sendPasswordReset).toBe(false);

      expect(await t.prisma.emailChallenge.count({ where: { purpose: 'PASSWORD_RESET' } })).toBe(0);
      expect(await t.prisma.auditLog.count({ where: { action: 'member.password_reset.send' } })).toBe(0);
    });
  });
});
