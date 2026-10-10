import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import { createProgram, createUser, factoryAdmin, loginAs, type TestUser } from './utils/factories';

const PUBLIC = '/api/v1/settings/public';
const ADMIN = '/api/v1/admin/settings';
const REASON = 'Switching the platform display for the pilot';

describe('settings (business rules §1)', () => {
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

  async function current() {
    const c = await loginAs(t, superAdmin);
    const res = await c.get(ADMIN).expect(200);
    return { c, settings: res.body.data };
  }

  it('GET /settings/public is public and returns the display format only', async () => {
    const res = await t.client().get(PUBLIC).expect(200);
    expect(res.body.data).toEqual({ rewardUnit: expect.any(String), currencyCode: 'INR', currencyMinorUnits: 2, pointsLabel: expect.any(String) });
  });

  it('GET /admin/settings requires settings:write (and an admin session)', async () => {
    const member = await createUser(t.prisma);
    await (await loginAs(t, member)).get(ADMIN).expect(403);
    const programAdmin = await createUser(t.prisma, { roles: ['PROGRAM_ADMIN'] });
    const res = await (await loginAs(t, programAdmin)).get(ADMIN).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    await (await loginAs(t, superAdmin, { mfa: 'EMAIL_OTP' })).get(ADMIN).expect(403);

    const { settings } = await current();
    expect(settings).toMatchObject({
      currencyCode: 'INR',
      currencyMinorUnits: 2,
      payoutsEnabled: false,
      version: expect.any(Number),
      liveProgramCount: 0,
      liveProgramCurrencyCodes: [],
    });
  });

  it('PUT updates with a reason and expected version, audits, bumps the version and refreshes the public format', async () => {
    await t.client().get(PUBLIC).expect(200); // warm the 30 s cache
    const { c, settings } = await current();
    const res = await c
      .put(ADMIN)
      .send({ expectedVersion: settings.version, reason: REASON, rewardUnit: 'MONEY', pointsLabel: 'Stars', pointsPerCurrencyUnit: 10 })
      .expect(200);
    expect(res.body.data).toMatchObject({
      rewardUnit: 'MONEY',
      pointsLabel: 'Stars',
      pointsPerCurrencyUnit: 10,
      version: settings.version + 1,
      updatedBy: { id: superAdmin.id },
    });
    const pub = await t.client().get(PUBLIC).expect(200);
    expect(pub.body.data).toMatchObject({ rewardUnit: 'MONEY', pointsLabel: 'Stars' });

    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'settings.update' } });
    expect(audit.reason).toBe(REASON);
    expect(audit.actorUserId).toBe(superAdmin.id);
    expect(audit.before).toMatchObject({ pointsLabel: expect.any(String), pointsPerCurrencyUnit: 1 });
    expect(audit.after).toMatchObject({ rewardUnit: 'MONEY', pointsLabel: 'Stars', pointsPerCurrencyUnit: 10 });
    expect(Object.keys(audit.before as object)).not.toContain('currencyCode');
  });

  it('rejects stale versions, missing reasons, unknown keys and out-of-range values', async () => {
    const { c, settings } = await current();
    const stale = await c.put(ADMIN).send({ expectedVersion: settings.version + 5, reason: REASON, pointsLabel: 'X' }).expect(409);
    expect(stale.body.error.code).toBe('STALE_VERSION');
    await c.put(ADMIN).send({ expectedVersion: settings.version, pointsLabel: 'X' }).expect(400);
    const payouts = await c.put(ADMIN).send({ expectedVersion: settings.version, reason: REASON, payoutsEnabled: true }).expect(400);
    expect(payouts.body.error.code).toBe('VALIDATION_FAILED');
    await c.put(ADMIN).send({ expectedVersion: settings.version, reason: REASON, defaultRewardBudgetBps: 5001 }).expect(400);
    await c.put(ADMIN).send({ expectedVersion: settings.version, reason: REASON, pointsPerCurrencyUnit: 0 }).expect(400);
    await c.put(ADMIN).send({ expectedVersion: settings.version, reason: REASON, currencyCode: 'XYZ' }).expect(400);
    await c.put(ADMIN).send({ expectedVersion: settings.version, reason: REASON }).expect(400);
    expect((await current()).settings.version).toBe(settings.version);
  });

  it('a change that changes nothing keeps the version and writes no audit entry', async () => {
    const { c, settings } = await current();
    const res = await c
      .put(ADMIN)
      .send({ expectedVersion: settings.version, reason: REASON, currencyCode: settings.currencyCode, pointsLabel: settings.pointsLabel })
      .expect(200);
    expect(res.body.data.version).toBe(settings.version);
    expect(await t.prisma.auditLog.count({ where: { action: 'settings.update' } })).toBe(0);
  });

  it('blocks a currency change while live programs use another currency, and snapshots minor units otherwise', async () => {
    const live = await createProgram(t.prisma, { status: 'ACTIVE', currencyCode: 'INR' });
    await createProgram(t.prisma, { status: 'DRAFT', currencyCode: 'INR' });
    const { c, settings } = await current();
    expect(settings).toMatchObject({ liveProgramCount: 1, liveProgramCurrencyCodes: ['INR'] });

    const blocked = await c.put(ADMIN).send({ expectedVersion: settings.version, reason: REASON, currencyCode: 'JPY' }).expect(409);
    expect(blocked.body.error.code).toBe('INVARIANT_VIOLATION');
    expect(blocked.body.error.details.programs).toEqual([expect.objectContaining({ id: live.id, currencyCode: 'INR' })]);

    // The DB guard enforces the same rule without the app pre-check.
    await expect(
      t.prisma.platformSettings.update({ where: { id: 1 }, data: { currencyCode: 'JPY', currencyMinorUnits: 0 } }),
    ).rejects.toThrow();

    // Once the live program is completed, the currency can change; minor units come from `currencies`.
    await t.prisma.$transaction(async (tx) => {
      await tx.program.update({ where: { id: live.id }, data: { status: 'COMPLETED', endsAt: new Date(), updatedById: superAdmin.id } });
    });
    const ok = await c.put(ADMIN).send({ expectedVersion: settings.version, reason: REASON, currencyCode: 'JPY' }).expect(200);
    expect(ok.body.data).toMatchObject({ currencyCode: 'JPY', currencyMinorUnits: 0, liveProgramCount: 0 });
    const pub = await t.client().get(PUBLIC).expect(200);
    expect(pub.body.data).toMatchObject({ currencyCode: 'JPY', currencyMinorUnits: 0 });
  });

  it('GET /admin/currencies lists the reference data', async () => {
    const c = await loginAs(t, superAdmin);
    const res = await c.get('/api/v1/admin/currencies').expect(200);
    expect(res.body.data).toEqual(expect.arrayContaining([{ code: 'JPY', name: 'Japanese Yen', minorUnits: 0 }]));
    const member = await createUser(t.prisma);
    await (await loginAs(t, member)).get('/api/v1/admin/currencies').expect(403);
  });
});
