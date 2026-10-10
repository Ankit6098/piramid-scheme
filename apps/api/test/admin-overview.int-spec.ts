import type { AdminOverviewDto } from '@app/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminOverviewService } from '../src/modules/admin/admin-overview.service';
import { ReconciliationService } from '../src/modules/reconciliation/reconciliation.service';
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

/**
 * Fixture (all "today"):
 *   P1 (ACTIVE, MONEY INR): anita > rahul > priya; anita + rahul ACTIVE, priya PENDING.
 *     e1 priya 1000.00 → rahul L1 100.00 (POSTED), anita L2 50.00 (PENDING_APPROVAL)
 *     e2 rahul 500.00 RECEIVED (unprocessed);  e3 REJECTED (not a qualifying sale)
 *   P2 (ACTIVE, MONEY USD): ravi > sunil (ACTIVE); e4 sunil 200.00 → ravi L1 20.00 (PENDING)
 *   P3 (DRAFT) — not active.
 *   Others: an unverified legacy account, a suspended member, a PROGRAM_ADMIN of P1, a FINANCE_REVIEWER.
 */
describe('GET /admin/overview', () => {
  let t: TestApp;
  let admin: TestUser;
  let programAdmin: TestUser;
  let finance: TestUser;
  let p1: { id: string };
  let p2: { id: string };

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
    await disconnectTestPrisma();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    await resetDatabase();
    t.get(ReconciliationService).invalidate();
    admin = await factoryAdmin(t.prisma);
    p1 = await createProgram(t.prisma, { rewardUnit: 'MONEY', currencyCode: 'INR' });
    p2 = await createProgram(t.prisma, { rewardUnit: 'MONEY', currencyCode: 'USD' });
    await createProgram(t.prisma, { status: 'DRAFT' });
    const pol1 = await createPolicy(t.prisma, { programId: p1.id });
    const pol2 = await createPolicy(t.prisma, { programId: p2.id });

    const anita = await createUser(t.prisma, { fullName: 'Anita Sharma' });
    const rahul = await createUser(t.prisma, { fullName: 'Rahul Verma', sponsor: anita });
    const priya = await createUser(t.prisma, { fullName: 'Priya Nair', sponsor: rahul });
    const ravi = await createUser(t.prisma, { fullName: 'Ravi Kumar' });
    const sunil = await createUser(t.prisma, { fullName: 'Sunil Rao', sponsor: ravi });
    await createUser(t.prisma, { status: 'PENDING_VERIFICATION', verified: false });
    await createUser(t.prisma, { status: 'SUSPENDED' });
    programAdmin = await createUser(t.prisma, { roles: ['PROGRAM_ADMIN'], programScopes: [p1.id] });
    finance = await createUser(t.prisma, { roles: ['FINANCE_REVIEWER'] });

    await createEnrollment(t.prisma, { userId: anita.id, programId: p1.id });
    await createEnrollment(t.prisma, { userId: rahul.id, programId: p1.id });
    await createEnrollment(t.prisma, { userId: priya.id, programId: p1.id, status: 'PENDING' });
    await createEnrollment(t.prisma, { userId: ravi.id, programId: p2.id });
    await createEnrollment(t.prisma, { userId: sunil.id, programId: p2.id });

    const e1 = await createEvent(t.prisma, { programId: p1.id, subjectUserId: priya.id, amountMinor: 100_000n });
    const { rewards } = await processEventForTest(t.prisma, {
      eventId: e1.id,
      policyVersionId: pol1.id,
      rewards: [
        { recipientUserId: rahul.id, level: 1, amountMinor: 10_000n },
        { recipientUserId: anita.id, level: 2, amountMinor: 5_000n },
      ],
    });
    await postRewardForTest(t.prisma, rewards[0]!.id, finance.id);
    await createEvent(t.prisma, { programId: p1.id, subjectUserId: rahul.id, amountMinor: 50_000n });
    await createEvent(t.prisma, { programId: p1.id, subjectUserId: rahul.id, amountMinor: 70_000n, status: 'REJECTED' });
    const e4 = await createEvent(t.prisma, { programId: p2.id, subjectUserId: sunil.id, amountMinor: 20_000n });
    await processEventForTest(t.prisma, {
      eventId: e4.id,
      policyVersionId: pol2.id,
      rewards: [{ recipientUserId: ravi.id, level: 1, amountMinor: 2_000n }],
    });

    await t.prisma.memberFlag.create({ data: { userId: priya.id, kind: 'MANUAL_REPORT', details: 'test flag' } });
    // Audit trail: 12 global entries, 2 for P1, 1 for P2 (newest last).
    for (let i = 0; i < 12; i++) {
      await t.prisma.auditLog.create({ data: { actorUserId: admin.id, actorRoles: ['SUPER_ADMIN'], action: `test.global.${i}`, resourceType: 'test' } });
    }
    await t.prisma.auditLog.create({ data: { actorUserId: admin.id, actorRoles: ['SUPER_ADMIN'], action: 'program.update', resourceType: 'program', resourceId: p1.id, programId: p1.id } });
    await t.prisma.auditLog.create({ data: { actorUserId: null, actorRoles: ['SYSTEM'], action: 'program.status', resourceType: 'program', resourceId: p1.id, programId: p1.id } });
    await t.prisma.auditLog.create({ data: { actorUserId: admin.id, actorRoles: ['SUPER_ADMIN'], action: 'program.update', resourceType: 'program', resourceId: p2.id, programId: p2.id } });
  });

  const today = () => new Date().toISOString().slice(0, 10);

  async function overviewAs(user: TestUser): Promise<AdminOverviewDto> {
    const client = await loginAs(t, user);
    const res = await client.get('/api/v1/admin/overview').expect(200);
    return res.body.data as AdminOverviewDto;
  }

  it('computes platform-wide figures for a SUPER_ADMIN', async () => {
    const o = await overviewAs(admin);
    const userCount = await t.prisma.user.count();
    expect(o.scope).toBe('ALL');
    expect(o.scopedProgramCount).toBeNull();
    expect(o.users).toEqual({ total: userCount, verified: userCount - 1, suspended: 1 });
    expect(o.activePrograms).toBe(2);
    expect(o.pendingEnrollments).toBe(1);
    expect(o.sales30d).toEqual({
      count: 3,
      byCurrency: [
        { currencyCode: 'INR', count: 2, amountMinor: '150000' },
        { currencyCode: 'USD', count: 1, amountMinor: '20000' },
      ],
    });
    expect(o.pendingRewardApprovals).toEqual({
      count: 2,
      byUnit: [
        { rewardUnit: 'MONEY', currencyCode: 'INR', count: 1, amountMinor: '5000' },
        { rewardUnit: 'MONEY', currencyCode: 'USD', count: 1, amountMinor: '2000' },
      ],
    });
    expect(o.postedRewards).toEqual([{ rewardUnit: 'MONEY', currencyCode: 'INR', count: 1, amountMinor: '10000' }]);
    expect(o.reconciliation).toEqual({ exceptionCount: 0, source: 'reconciliation' });
    expect(o.openFlags).toBe(1);
    expect(typeof o.deadOutboxMessages).toBe('number');

    expect(o.recentActions).toHaveLength(10);
    expect(o.recentActions[0]).toMatchObject({ action: 'program.update', program: { id: p2.id }, actor: { id: admin.id } });
    expect(o.recentActions[1]).toMatchObject({ action: 'program.status', actor: null, actorRoles: ['SYSTEM'] });

    expect(o.daily).toHaveLength(30);
    const last = o.daily[29]!;
    expect(last.date).toBe(today());
    expect(last).toMatchObject({ registrations: userCount, sales: 3, rewardsPosted: 1 });
    expect(o.daily.reduce((s, p) => s + p.sales, 0)).toBe(o.sales30d.count);
    expect(o.daily.slice(0, 29).every((p) => p.registrations === 0 && p.sales === 0 && p.rewardsPosted === 0)).toBe(true);
  });

  it('limits every figure to the assigned programs for a PROGRAM_ADMIN', async () => {
    const o = await overviewAs(programAdmin);
    expect(o.scope).toBe('PROGRAMS');
    expect(o.scopedProgramCount).toBe(1);
    // Members with an enrollment in P1: anita, rahul, priya.
    expect(o.users).toEqual({ total: 3, verified: 3, suspended: 0 });
    expect(o.activePrograms).toBe(1);
    expect(o.pendingEnrollments).toBe(1);
    expect(o.sales30d).toEqual({ count: 2, byCurrency: [{ currencyCode: 'INR', count: 2, amountMinor: '150000' }] });
    expect(o.pendingRewardApprovals).toEqual({
      count: 1,
      byUnit: [{ rewardUnit: 'MONEY', currencyCode: 'INR', count: 1, amountMinor: '5000' }],
    });
    expect(o.postedRewards).toEqual([{ rewardUnit: 'MONEY', currencyCode: 'INR', count: 1, amountMinor: '10000' }]);
    expect(o.openFlags).toBeNull();
    expect(o.deadOutboxMessages).toBeNull();
    expect(o.recentActions.map((a) => a.program?.id)).toEqual([p1.id, p1.id]);
    expect(o.daily[29]).toMatchObject({ registrations: 3, sales: 2, rewardsPosted: 1 });
  });

  it('a PROGRAM_ADMIN without assignments sees zeros', async () => {
    const unassigned = await createUser(t.prisma, { roles: ['PROGRAM_ADMIN'] });
    const o = await overviewAs(unassigned);
    expect(o.scopedProgramCount).toBe(0);
    expect(o.users.total).toBe(0);
    expect(o.activePrograms).toBe(0);
    expect(o.sales30d.count).toBe(0);
    expect(o.recentActions).toEqual([]);
    expect(o.daily.every((p) => p.registrations + p.sales + p.rewardsPosted === 0)).toBe(true);
  });

  it('a FINANCE_REVIEWER sees platform-wide figures and the audit trail but not the outbox', async () => {
    const o = await overviewAs(finance);
    expect(o.scope).toBe('ALL');
    expect(o.sales30d.count).toBe(3);
    expect(o.recentActions).toHaveLength(10);
    expect(o.openFlags).toBe(1);
    expect(o.deadOutboxMessages).toBeNull();
  });

  it('uses the reconciliation report platform-wide and a scoped subset for program admins', async () => {
    const service = t.get(AdminOverviewService);
    const auth = { userId: admin.id, roles: ['MEMBER', 'SUPER_ADMIN'], permissions: new Set(['audit:read']), programScopes: [] };
    const later = new Date(Date.now() + 20 * 60_000);
    // e2 (P1) is still RECEIVED: 20 minutes later it counts as stuck for P1's admins only.
    const p1Admin = { ...auth, roles: ['MEMBER', 'PROGRAM_ADMIN'], programScopes: [p1.id] };
    expect((await service.getOverview(p1Admin as never, later)).reconciliation).toEqual({ exceptionCount: 1, source: 'basic' });
    const p2Admin = { ...auth, roles: ['MEMBER', 'PROGRAM_ADMIN'], programScopes: [p2.id] };
    expect((await service.getOverview(p2Admin as never, later)).reconciliation).toEqual({ exceptionCount: 0, source: 'basic' });

    const recon = t.get(ReconciliationService);
    vi.spyOn(recon, 'countExceptions').mockResolvedValueOnce(7);
    expect((await service.getOverview(auth as never, later)).reconciliation).toEqual({ exceptionCount: 7, source: 'reconciliation' });
    // A failing report degrades to the built-in platform-wide count instead of failing the overview.
    vi.spyOn(recon, 'countExceptions').mockRejectedValueOnce(new Error('boom'));
    expect((await service.getOverview(auth as never, later)).reconciliation).toEqual({ exceptionCount: 1, source: 'basic' });
  });

  it('requires an admin role and a TOTP-verified session', async () => {
    const member = await createUser(t.prisma);
    await (await loginAs(t, member)).get('/api/v1/admin/overview').expect(403);
    const res = await (await loginAs(t, admin, { mfa: 'EMAIL_OTP' })).get('/api/v1/admin/overview').expect(403);
    expect(res.body.error.code).toBe('MFA_REQUIRED');
    await t.client().get('/api/v1/admin/overview').expect(401);
  });
});
