import type { ApiPage, AuditLogDetailDto, AuditLogListItemDto } from '@app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import { createProgram, createUser, factoryAdmin, loginAs, type TestUser } from './utils/factories';

describe('GET /admin/audit', () => {
  let t: TestApp;
  let admin: TestUser;
  let finance: TestUser;
  let programAdmin: TestUser;
  let p1: { id: string; name: string; code: string };
  let ids: Record<string, string>;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
    await disconnectTestPrisma();
  });

  beforeEach(async () => {
    await resetDatabase();
    admin = await factoryAdmin(t.prisma);
    finance = await createUser(t.prisma, { fullName: 'Farhan Finance', roles: ['FINANCE_REVIEWER'] });
    p1 = await createProgram(t.prisma, { name: 'Spring Promo' });
    programAdmin = await createUser(t.prisma, { roles: ['PROGRAM_ADMIN'], programScopes: [p1.id] });
    const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000);
    const mk = (data: Parameters<typeof t.prisma.auditLog.create>[0]['data']) =>
      t.prisma.auditLog.create({ data: { actorRoles: [], ...data }, select: { id: true } }).then((r) => r.id);
    ids = {
      suspend: await mk({
        actorUserId: admin.id,
        actorRoles: ['MEMBER', 'SUPER_ADMIN'],
        action: 'member.suspend',
        resourceType: 'user',
        resourceId: finance.id,
        before: { status: 'ACTIVE' },
        after: { status: 'SUSPENDED', sessionsRevoked: 2 },
        reason: 'Suspicious activity reported',
        requestId: 'req-12345678',
        ipAddress: '203.0.113.9',
        createdAt: at(1),
      }),
      policy: await mk({
        actorUserId: admin.id,
        action: 'policy.publish',
        resourceType: 'policy_version',
        resourceId: 'pv-1',
        programId: p1.id,
        before: { status: 'DRAFT', rules: [{ level: 1, percentageBps: 1000 }] },
        after: { status: 'PUBLISHED', rules: [{ level: 1, percentageBps: 1500 }] },
        createdAt: at(3),
      }),
      system: await mk({ actorUserId: null, actorRoles: ['SYSTEM'], action: 'program.status', resourceType: 'program', resourceId: p1.id, programId: p1.id, createdAt: at(5) }),
      finance: await mk({ actorUserId: finance.id, action: 'reward.approve', resourceType: 'reward', resourceId: 'rw-1', createdAt: at(10) }),
      old: await mk({ actorUserId: admin.id, action: 'settings.update', resourceType: 'platform_settings', resourceId: '1', createdAt: at(40) }),
    };
  });

  const list = async (user: TestUser, query = '') =>
    (await (await loginAs(t, user)).get(`/api/v1/admin/audit${query}`).expect(200)).body as ApiPage<AuditLogListItemDto>;

  it('lists newest first with actor, program and changed fields', async () => {
    const page = await list(admin);
    expect(page.data.map((e) => e.id)).toEqual([ids.suspend, ids.policy, ids.system, ids.finance, ids.old]);
    expect(page.data[0]).toEqual({
      id: ids.suspend,
      createdAt: expect.any(String),
      action: 'member.suspend',
      resourceType: 'user',
      resourceId: finance.id,
      program: null,
      actor: { id: admin.id, fullName: admin.fullName },
      actorRoles: ['MEMBER', 'SUPER_ADMIN'],
      reason: 'Suspicious activity reported',
      changedFields: ['sessionsRevoked', 'status'],
    });
    expect(page.data[1]!.program).toEqual({ id: p1.id, code: p1.code, name: 'Spring Promo' });
    expect(page.data[2]!.actor).toBeNull();
  });

  it('filters by actor, action prefix, resource, program and date range', async () => {
    const idsOf = (p: ApiPage<AuditLogListItemDto>) => p.data.map((e) => e.id);
    expect(idsOf(await list(admin, `?actorId=${finance.id}`))).toEqual([ids.finance]);
    expect(idsOf(await list(admin, '?action=member.'))).toEqual([ids.suspend]);
    expect(idsOf(await list(admin, '?action=p'))).toEqual([ids.policy, ids.system]);
    expect(idsOf(await list(admin, `?resourceType=user&resourceId=${finance.id}`))).toEqual([ids.suspend]);
    expect(idsOf(await list(admin, `?programId=${p1.id}`))).toEqual([ids.policy, ids.system]);
    const from = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const to = new Date(Date.now() - 2 * 86_400_000).toISOString();
    expect(idsOf(await list(admin, `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`))).toEqual([ids.policy, ids.system]);
    const bad = await (await loginAs(t, admin)).get(`/api/v1/admin/audit?from=${encodeURIComponent(to)}&to=${encodeURIComponent(from)}`).expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    await (await loginAs(t, admin)).get('/api/v1/admin/audit?actorId=nope').expect(400);
  });

  it('paginates with an opaque cursor', async () => {
    const client = await loginAs(t, admin);
    const first = (await client.get('/api/v1/admin/audit?limit=2').expect(200)).body as ApiPage<AuditLogListItemDto>;
    expect(first.data.map((e) => e.id)).toEqual([ids.suspend, ids.policy]);
    const second = (await client.get(`/api/v1/admin/audit?limit=2&cursor=${first.page.nextCursor}`).expect(200)).body as ApiPage<AuditLogListItemDto>;
    expect(second.data.map((e) => e.id)).toEqual([ids.system, ids.finance]);
    const third = (await client.get(`/api/v1/admin/audit?limit=2&cursor=${second.page.nextCursor}`).expect(200)).body as ApiPage<AuditLogListItemDto>;
    expect(third.data.map((e) => e.id)).toEqual([ids.old]);
    expect(third.page.nextCursor).toBeNull();
  });

  it('returns before/after with a field-level diff', async () => {
    const client = await loginAs(t, finance);
    const d = (await client.get(`/api/v1/admin/audit/${ids.policy}`).expect(200)).body.data as AuditLogDetailDto;
    expect(d.before).toEqual({ status: 'DRAFT', rules: [{ level: 1, percentageBps: 1000 }] });
    expect(d.changes).toEqual([
      { path: 'rules.0.percentageBps', kind: 'changed', before: 1000, after: 1500 },
      { path: 'status', kind: 'changed', before: 'DRAFT', after: 'PUBLISHED' },
    ]);
    const s = (await client.get(`/api/v1/admin/audit/${ids.suspend}`).expect(200)).body.data as AuditLogDetailDto;
    expect(s).toMatchObject({ requestId: 'req-12345678', ipAddress: '203.0.113.9' });
    expect(s.changes).toEqual([
      { path: 'sessionsRevoked', kind: 'added', before: null, after: 2 },
      { path: 'status', kind: 'changed', before: 'ACTIVE', after: 'SUSPENDED' },
    ]);
    await client.get('/api/v1/admin/audit/00000000-0000-4000-8000-000000000000').expect(404);
  });

  it('requires audit:read (FINANCE_REVIEWER yes; PROGRAM_ADMIN and members no)', async () => {
    expect((await list(finance)).data).toHaveLength(5);
    const pa = await loginAs(t, programAdmin);
    const res = await pa.get('/api/v1/admin/audit').expect(403);
    expect(res.body.error.details.missingPermissions).toEqual(['audit:read']);
    await pa.get(`/api/v1/admin/audit/${ids.policy}`).expect(403);
    const member = await createUser(t.prisma);
    await (await loginAs(t, member)).get('/api/v1/admin/audit').expect(403);
  });

  it('records real admin actions that the log then shows', async () => {
    const member = await createUser(t.prisma, { fullName: 'Meera Member' });
    const client = await loginAs(t, admin);
    await client.post(`/api/v1/admin/members/${member.id}/suspend`).send({ reason: 'Chargeback pattern under review' }).expect(200);
    const page = await list(admin, `?resourceType=user&resourceId=${member.id}`);
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({ action: 'member.suspend', actor: { id: admin.id }, reason: 'Chargeback pattern under review' });
    const detail = (await client.get(`/api/v1/admin/audit/${page.data[0]!.id}`).expect(200)).body.data as AuditLogDetailDto;
    expect(detail.requestId).toEqual(expect.any(String));
    expect(detail.changes).toContainEqual({ path: 'status', kind: 'changed', before: 'ACTIVE', after: 'SUSPENDED' });
  });
});
