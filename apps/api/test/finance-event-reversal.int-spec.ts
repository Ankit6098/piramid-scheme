import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ReconciliationService } from '../src/modules/reconciliation/reconciliation.service';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import { createEvent, loginAs } from './utils/factories';
import { adminClient, idemKey, ledgerOf, saleScenario } from './finance-fixtures';

describe('POST /admin/events/:id/reverse (refund / chargeback)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await t?.close();
    await disconnectTestPrisma();
  });

  const reviewer = () => adminClient(t, ['FINANCE_REVIEWER']);
  const reverse = (client: Awaited<ReturnType<typeof reviewer>>['client'], eventId: string, reason = 'Customer refund #4411') =>
    client.post(`/api/v1/admin/events/${eventId}/reverse`).set('Idempotency-Key', idemKey()).send({ reason });

  it('reverses a sale with mixed reward states in one transaction', async () => {
    const s = await saleScenario(t);
    const { user, client } = await reviewer();
    const [posted, pending] = s.rewards;
    await client.post(`/api/v1/admin/rewards/${posted!.id}/approve`).set('Idempotency-Key', idemKey()).expect(200);

    const res = await reverse(client, s.eventId);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      eventId: s.eventId,
      status: 'REVERSED',
      reversedRewardIds: [posted!.id],
      rejectedRewardIds: [pending!.id],
    });

    const event = await t.prisma.qualifyingEvent.findUniqueOrThrow({ where: { id: s.eventId } });
    expect(event).toMatchObject({ status: 'REVERSED', reversalReason: 'Customer refund #4411' });
    expect(await t.prisma.reward.findUniqueOrThrow({ where: { id: posted!.id } })).toMatchObject({
      status: 'REVERSED',
      reversedById: user.id,
      reversalReason: 'Sale reversed: Customer refund #4411',
    });
    expect(await t.prisma.reward.findUniqueOrThrow({ where: { id: pending!.id } })).toMatchObject({
      status: 'REJECTED',
      rejectedById: user.id,
      rejectionReason: 'Sale reversed: Customer refund #4411',
    });
    expect((await ledgerOf(t, posted!.id)).map((x) => x.type)).toEqual(['REWARD_POSTING', 'REWARD_REVERSAL']);
    expect(await t.prisma.ledgerTransaction.count({ where: { rewardId: pending!.id } })).toBe(0);

    // Notifications for both members, audit for the event and each reward.
    const keys = (await t.prisma.outboxMessage.findMany({ where: { topic: 'notification.create' }, select: { dedupeKey: true } })).map(
      (m) => m.dedupeKey,
    );
    expect(keys).toEqual(
      expect.arrayContaining([`notification:reward-reversed:${posted!.id}`, `notification:reward-rejected:${pending!.id}`]),
    );
    expect(await t.prisma.auditLog.findFirst({ where: { action: 'event.reverse', resourceId: s.eventId } })).toMatchObject({
      programId: s.program.id,
      reason: 'Customer refund #4411',
    });
    expect(await t.prisma.auditLog.count({ where: { action: { in: ['reward.reverse', 'reward.reject'] } } })).toBe(2);

    const again = await reverse(client, s.eventId);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe('This sale has already been reversed.');

    const report = await t.get(ReconciliationService).report(true);
    expect(report.totalExceptions).toBe(0);
  });

  it('refuses when the actor received a reward from the sale (friendly 409, nothing changes)', async () => {
    const s = await saleScenario(t, { anita: { roles: ['FINANCE_REVIEWER'] } });
    const anitaClient = await loginAs(t, s.anita);
    const res = await reverse(anitaClient, s.eventId);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'CONFLICT', details: { reason: 'SEGREGATION_OF_DUTIES', rule: 'OWN_REWARD' } });
    expect(res.body.error.message).toMatch(/Another reviewer must reverse this sale/);
    expect((await t.prisma.qualifyingEvent.findUniqueOrThrow({ where: { id: s.eventId } })).status).toBe('PROCESSED');
  });

  it('refuses unprocessed sales, validates input and checks permissions', async () => {
    const s = await saleScenario(t);
    const { client } = await reviewer();
    const received = await createEvent(t.prisma, { programId: s.program.id, subjectUserId: s.priya.id });

    const notYet = await reverse(client, received.id);
    expect(notYet.status).toBe(409);
    expect(notYet.body.error).toMatchObject({ code: 'INVALID_STATE_TRANSITION' });

    expect((await reverse(client, s.eventId, 'short')).status).toBe(400);
    expect((await reverse(client, '00000000-0000-4000-8000-000000000000')).status).toBe(404);

    const programAdmin = await adminClient(t, ['PROGRAM_ADMIN'], { programScopes: [s.program.id] });
    const denied = await reverse(programAdmin.client, s.eventId);
    expect(denied.status).toBe(403);
    expect(denied.body.error.details).toMatchObject({ missingPermissions: ['events:reverse'] });
  });

  it('serializes with concurrent approvals: never leaves a live reward on a reversed sale', async () => {
    for (let round = 0; round < 3; round++) {
      await resetDatabase();
      const s = await saleScenario(t);
      const approver = await reviewer();
      const reverser = await reviewer();
      const [approve0, approve1, rev] = await Promise.all([
        approver.client.post(`/api/v1/admin/rewards/${s.rewards[0]!.id}/approve`).set('Idempotency-Key', idemKey()),
        approver.client.post(`/api/v1/admin/rewards/${s.rewards[1]!.id}/approve`).set('Idempotency-Key', idemKey()),
        reverse(reverser.client, s.eventId),
      ]);
      expect(rev.status).toBe(200);
      for (const a of [approve0, approve1]) {
        expect([200, 409]).toContain(a.status);
        if (a.status === 409) expect(a.body.error.code).toBe('INVALID_STATE_TRANSITION');
      }
      const rewards = await t.prisma.reward.findMany({ where: { eventId: s.eventId } });
      for (const r of rewards) {
        expect(['REJECTED', 'REVERSED']).toContain(r.status);
        const txns = await t.prisma.ledgerTransaction.count({ where: { rewardId: r.id } });
        expect(txns).toBe(r.status === 'REVERSED' ? 2 : 0);
      }
      expect((await t.get(ReconciliationService).report(true)).totalExceptions).toBe(0);
    }
  });
});
