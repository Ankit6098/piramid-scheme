import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import { createOffering, createProgram, createUser, factoryAdmin, loginAs, type TestUser } from './utils/factories';

const BASE = '/api/v1/admin/offerings';
const REASON = 'Supplier contract ended this month';

describe('admin offerings (business rules §4)', () => {
  let t: TestApp;
  let superAdmin: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
  });
  beforeEach(async () => {
    await resetDatabase();
    superAdmin = await factoryAdmin(t.prisma);
  });
  afterAll(async () => {
    await t?.close();
    await disconnectTestPrisma();
  });

  it('creates offerings INACTIVE and audits it; only offerings:write may create', async () => {
    const c = await loginAs(t, superAdmin);
    const res = await c.post(BASE).send({ name: 'Water purifier', kind: 'PRODUCT', sku: 'WP-100', description: '' }).expect(201);
    expect(res.body.data).toMatchObject({
      name: 'Water purifier',
      kind: 'PRODUCT',
      sku: 'WP-100',
      description: null,
      status: 'INACTIVE',
      approvedBy: null,
      createdBy: { id: superAdmin.id },
      programCount: 0,
      liveProgramCount: 0,
    });
    expect(await t.prisma.auditLog.count({ where: { action: 'offering.create', resourceId: res.body.data.id } })).toBe(1);

    const programAdmin = await createUser(t.prisma, { roles: ['PROGRAM_ADMIN'] });
    const pa = await loginAs(t, programAdmin);
    await pa.post(BASE).send({ name: 'Other', kind: 'SERVICE' }).expect(403);
    // …but program admins can read offerings (to choose one for a program).
    const list = await pa.get(BASE).expect(200);
    expect(list.body.data.map((o: { id: string }) => o.id)).toContain(res.body.data.id);
    const member = await createUser(t.prisma);
    await (await loginAs(t, member)).get(BASE).expect(403);
  });

  it('validates input and keeps SKUs unique', async () => {
    const c = await loginAs(t, superAdmin);
    await c.post(BASE).send({ name: 'A', kind: 'PRODUCT' }).expect(400);
    await c.post(BASE).send({ name: 'Valid name', kind: 'GADGET' }).expect(400);
    await c.post(BASE).send({ name: 'Valid name', kind: 'PRODUCT', sku: 'bad sku!' }).expect(400);
    await c.post(BASE).send({ name: 'First', kind: 'PRODUCT', sku: 'DUP-1' }).expect(201);
    const dup = await c.post(BASE).send({ name: 'Second', kind: 'PRODUCT', sku: 'DUP-1' }).expect(409);
    expect(dup.body.error.details.issues[0].path).toBe('sku');
  });

  it('approves and deactivates (offerings:approve), with state checks and audit', async () => {
    const c = await loginAs(t, superAdmin);
    const created = (await c.post(BASE).send({ name: 'Solar lamp', kind: 'PRODUCT' }).expect(201)).body.data;
    const approved = await c.post(`${BASE}/${created.id}/approve`).expect(200);
    expect(approved.body.data).toMatchObject({ status: 'ACTIVE', approvedBy: { id: superAdmin.id } });
    expect(approved.body.data.approvedAt).toEqual(expect.any(String));
    const again = await c.post(`${BASE}/${created.id}/approve`).send({}).expect(409);
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');

    await c.post(`${BASE}/${created.id}/deactivate`).send({}).expect(400);
    const deactivated = await c.post(`${BASE}/${created.id}/deactivate`).send({ reason: REASON }).expect(200);
    expect(deactivated.body.data.status).toBe('INACTIVE');
    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'offering.deactivate', resourceId: created.id } });
    expect(audit.reason).toBe(REASON);

    const programAdmin = await createUser(t.prisma, { roles: ['PROGRAM_ADMIN'] });
    await (await loginAs(t, programAdmin)).post(`${BASE}/${created.id}/approve`).expect(403);
  });

  it('edits only changed fields and reports usage counts', async () => {
    const offering = await createOffering(t.prisma, { status: 'ACTIVE', name: 'Gym membership', kind: 'SERVICE' });
    await createProgram(t.prisma, { offeringId: offering.id, status: 'ACTIVE' });
    await createProgram(t.prisma, { offeringId: offering.id, status: 'DRAFT' });
    const c = await loginAs(t, superAdmin);
    const res = await c.patch(`${BASE}/${offering.id}`).send({ name: 'Gym membership (annual)', kind: 'SERVICE' }).expect(200);
    expect(res.body.data).toMatchObject({ name: 'Gym membership (annual)', programCount: 2, liveProgramCount: 1 });
    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'offering.update', resourceId: offering.id } });
    expect(audit.before).toEqual({ name: 'Gym membership' });
    expect(audit.after).toEqual({ name: 'Gym membership (annual)' });
    await c.patch(`${BASE}/${offering.id}`).send({}).expect(400);
  });

  it('deletes only unused, inactive offerings', async () => {
    const c = await loginAs(t, superAdmin);
    const used = await createOffering(t.prisma, { status: 'INACTIVE' });
    await createProgram(t.prisma, { offeringId: used.id, status: 'DRAFT' });
    expect((await c.delete(`${BASE}/${used.id}`).expect(409)).body.error.code).toBe('INVALID_STATE_TRANSITION');
    const active = await createOffering(t.prisma, { status: 'ACTIVE' });
    await c.delete(`${BASE}/${active.id}`).expect(409);
    const unused = await createOffering(t.prisma, { status: 'INACTIVE' });
    await c.delete(`${BASE}/${unused.id}`).expect(204);
    await c.get(`${BASE}/${unused.id}`).expect(404);
  });

  it('lists with filters, search and cursor pagination', async () => {
    for (let i = 0; i < 5; i++) await createOffering(t.prisma, { status: i % 2 ? 'ACTIVE' : 'INACTIVE', name: `Item ${i}` });
    await createOffering(t.prisma, { status: 'ACTIVE', name: 'Special kettle', sku: 'KET-9' });
    const c = await loginAs(t, superAdmin);
    const active = await c.get(`${BASE}?status=ACTIVE`).expect(200);
    expect(active.body.data.every((o: { status: string }) => o.status === 'ACTIVE')).toBe(true);
    const search = await c.get(`${BASE}?q=ket-9`).expect(200);
    expect(search.body.data.map((o: { name: string }) => o.name)).toEqual(['Special kettle']);

    const first = await c.get(`${BASE}?limit=4`).expect(200);
    expect(first.body.data).toHaveLength(4);
    expect(first.body.page.nextCursor).toEqual(expect.any(String));
    const second = await c.get(`${BASE}?limit=4&cursor=${first.body.page.nextCursor}`).expect(200);
    expect(second.body.data).toHaveLength(2);
    expect(second.body.page.nextCursor).toBeNull();
    const ids = new Set([...first.body.data, ...second.body.data].map((o: { id: string }) => o.id));
    expect(ids.size).toBe(6);
    await c.get(`${BASE}?cursor=not-a-cursor`).expect(400);
  });
});
