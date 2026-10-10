import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ReconciliationService } from '../src/modules/reconciliation/reconciliation.service';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import { createEnrollment, createEvent, createProgram, factoryAdmin, loginAs, sha256 } from './utils/factories';
import { adminClient, anotherSale, idemKey, saleScenario } from './finance-fixtures';

describe('reconciliation report (/admin/reconciliation)', () => {
  let t: TestApp;
  let service: ReconciliationService;

  beforeAll(async () => {
    t = await createTestApp();
    service = t.get(ReconciliationService);
  });
  beforeEach(async () => {
    await resetDatabase();
    service.invalidate();
  });
  afterAll(async () => {
    await t?.close();
    await disconnectTestPrisma();
  });

  /** Approved, reversed, rejected rewards and a reversed sale — everything through the API. */
  async function busyButCleanLedger() {
    const s = await saleScenario(t);
    const sale2 = await anotherSale(t, s, 60_000n);
    const sale3 = await anotherSale(t, s, 30_000n);
    const { client } = await adminClient(t, ['FINANCE_REVIEWER']);
    const approve = (id: string) => client.post(`/api/v1/admin/rewards/${id}/approve`).set('Idempotency-Key', idemKey()).expect(200);
    await approve(s.rewards[0]!.id);
    await approve(s.rewards[1]!.id);
    await client.post(`/api/v1/admin/rewards/${s.rewards[1]!.id}/reverse`).set('Idempotency-Key', idemKey()).send({ reason: 'Refund issued to customer' }).expect(200);
    await client.post(`/api/v1/admin/rewards/${sale2.rewards[0]!.id}/reject`).set('Idempotency-Key', idemKey()).send({ reason: 'Not a verifiable sale' }).expect(200);
    await approve(sale3.rewards[0]!.id);
    await client.post(`/api/v1/admin/events/${sale3.eventId}/reverse`).set('Idempotency-Key', idemKey()).send({ reason: 'Chargeback from the bank' }).expect(200);
    return { s, client };
  }

  it('reports zero exceptions on clean data, with consistent summary figures', async () => {
    const { client } = await busyButCleanLedger();
    const res = await client.get('/api/v1/admin/reconciliation?refresh=true');
    expect(res.status).toBe(200);
    const report = res.body.data;
    expect(report).toMatchObject({ healthy: true, totalExceptions: 0, truncated: false, exceptions: [] });
    expect(report.checks).toHaveLength(8);
    expect(report.checks.every((c: { passed: boolean; count: number }) => c.passed && c.count === 0)).toBe(true);
    expect(report.summary.rewardsByStatus).toMatchObject({ POSTED: 1, REVERSED: 2, REJECTED: 2, PENDING_APPROVAL: 1 });
    expect(report.summary.eventsByStatus).toMatchObject({ PROCESSED: 2, REVERSED: 1 });
    const [bucket] = report.summary.buckets;
    expect(bucket.rewardsPostedMinor).toBe(bucket.ledgerPostedMinor);
    expect(bucket.rewardsReversedMinor).toBe(bucket.ledgerReversedMinor);
    expect(bucket.payableBalanceMinor).toBe(bucket.expectedPayableMinor);
    expect(bucket).toMatchObject({ rewardUnit: 'MONEY', currencyCode: 'INR', expectedPayableMinor: '10000' });
    expect(await service.countExceptions()).toBe(0);
  });

  it('detects a sale stuck in RECEIVED (planted outside the app) and counts it', async () => {
    const s = await saleScenario(t);
    // Test-only path: back-date created_at so the sale looks stuck for 20 minutes.
    const stuck = await t.prisma.qualifyingEvent.create({
      data: {
        programId: s.program.id,
        offeringId: s.program.offeringId,
        type: 'PRODUCT_SALE',
        source: 'ADMIN_MANUAL',
        externalId: 'STUCK-1',
        requestHash: sha256('stuck-1'),
        customerReference: 'CUST-STUCK',
        subjectUserId: s.priya.id,
        amountMinor: 12_345n,
        currencyCode: s.program.currencyCode,
        occurredAt: new Date(),
        recordedById: (await factoryAdmin(t.prisma)).id,
        createdAt: new Date(Date.now() - 20 * 60_000),
      },
    });
    // A fresh RECEIVED sale is not an exception.
    await createEvent(t.prisma, { programId: s.program.id, subjectUserId: s.priya.id });

    const report = await service.report(true);
    expect(report.healthy).toBe(false);
    expect(report.totalExceptions).toBe(1);
    expect(report.checks.find((c) => c.key === 'EVENT_STUCK_RECEIVED')).toMatchObject({ count: 1, passed: false, severity: 'warning' });
    expect(report.exceptions).toEqual([
      expect.objectContaining({
        check: 'EVENT_STUCK_RECEIVED',
        resourceType: 'qualifying_event',
        resourceId: stuck.id,
        programId: s.program.id,
        details: expect.objectContaining({ externalId: 'STUCK-1' }),
      }),
    ]);
    expect(await service.countExceptions()).toBe(1);
  });

  it('queues sales that resemble the subject’s own plan payment for compliance review', async () => {
    await factoryAdmin(t.prisma);
    const program = await createProgram(t.prisma, { options: [{ name: 'Annual plan', priceMinor: 49_900n, billingFrequency: 'YEARLY', durationDays: 365 }] });
    const s = await saleScenario(t);
    // The sale is recorded first, the member's own plan payment of the same amount afterwards
    // (the DB only blocks the other order at insert time).
    const lookalike = await createEvent(t.prisma, { programId: program.id, subjectUserId: s.priya.id, amountMinor: 49_900n });
    await createEnrollment(t.prisma, { userId: s.priya.id, programId: program.id });

    const report = await service.report(true);
    expect(report.checks.find((c) => c.key === 'PLAN_PAYMENT_LOOKALIKE')).toMatchObject({ count: 1, severity: 'review' });
    expect(report.exceptions.map((e) => [e.check, e.resourceId])).toEqual([['PLAN_PAYMENT_LOOKALIKE', lookalike.id]]);
    expect(report.healthy).toBe(true); // review items do not make the ledger unhealthy
  });

  it('detects a reward/ledger mismatch planted with the integrity triggers disabled', async (ctx) => {
    const roles = await t.prisma.$queryRaw<Array<{ rolsuper: boolean }>>`
      SELECT rolsuper FROM pg_roles WHERE rolname = current_user`;
    if (!roles[0]?.rolsuper) ctx.skip(); // needs session_replication_role (superuser), as in the dev/CI containers

    const s = await saleScenario(t);
    const { user } = await adminClient(t, ['FINANCE_REVIEWER']);
    const reward = s.rewards[0]!;
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      await tx.$executeRaw`
        UPDATE "rewards" SET "status" = 'POSTED', "approved_at" = now(), "approved_by_id" = ${user.id}::uuid, "posted_at" = now()
         WHERE "id" = ${reward.id}::uuid`;
    });

    const report = await service.report(true);
    expect(report.healthy).toBe(false);
    const keys = report.exceptions.map((e) => [e.check, e.resourceType, e.resourceId]);
    expect(keys).toEqual(
      expect.arrayContaining([
        ['REWARD_LEDGER_STATUS_MISMATCH', 'reward', reward.id],
        ['PAYABLE_BALANCE_MISMATCH', 'member', s.rahul.id],
      ]),
    );
    expect(report.exceptions.find((e) => e.check === 'PAYABLE_BALANCE_MISMATCH')?.details).toMatchObject({
      balanceMinor: '0',
      expectedMinor: '10000',
    });
  });

  it('caches for ~60 s, refreshes on demand and is limited to global finance roles', async () => {
    const s = await saleScenario(t);
    const { client } = await adminClient(t, ['FINANCE_REVIEWER']);
    const first = await client.get('/api/v1/admin/reconciliation?refresh=true');
    const cached = await client.get('/api/v1/admin/reconciliation');
    expect(cached.body.data.generatedAt).toBe(first.body.data.generatedAt);
    await new Promise((r) => setTimeout(r, 5));
    const fresh = await client.get('/api/v1/admin/reconciliation?refresh=true');
    expect(fresh.body.data.generatedAt).not.toBe(first.body.data.generatedAt);

    const programAdmin = await adminClient(t, ['PROGRAM_ADMIN'], { programScopes: [s.program.id] });
    expect((await programAdmin.client.get('/api/v1/admin/reconciliation')).status).toBe(403);
    expect((await (await loginAs(t, s.rahul)).get('/api/v1/admin/reconciliation')).status).toBe(403);
  });
});
