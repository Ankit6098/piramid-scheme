/**
 * Compliance: plan payments never fund rewards (business rules §0.1, §8, §11) — regression tests for
 * the adversarial-review findings F1 (plan payment from another program), F2 (a recruit's plan
 * payment recorded as the sponsor's sale), F3 (back-dated sale escaping the ±2-day window) and F4
 * (POINTS base overflow leaving a sale stuck in RECEIVED).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AdminRewardDetailDto, AdminRewardRowDto, RecordSaleResultDto, SaleEventDetailDto } from '@app/shared';
import { inspectDbError } from '../src/common/errors/db-error';
import { EventIntakeService } from '../src/modules/events/event-intake.service';
import { ReconciliationService } from '../src/modules/reconciliation/reconciliation.service';
import { RewardEngineService } from '../src/modules/rewards/reward-engine.service';
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
  processEventForTest,
  type LoggedInClient,
  type TestUser,
} from './utils/factories';
import { adminClient, idemKey } from './finance-fixtures';

const DAY = 86_400_000;

/** Awaits a write the database must refuse with a trigger (23001 restrict_violation). */
async function refusedByDb(p: Promise<unknown>, message: RegExp): Promise<void> {
  let error: unknown;
  try {
    await p;
  } catch (e) {
    error = e;
  }
  expect(error, 'expected the database to refuse the write').toBeDefined();
  const info = inspectDbError(error);
  expect(info?.sqlState, String(error)).toBe('23001');
  expect(info?.message ?? String(error)).toMatch(message);
}

describe('compliance: plan payments never fund rewards', () => {
  let t: TestApp;
  let su: LoggedInClient;
  let superAdmin: TestUser;
  let seq = 0;

  beforeAll(async () => {
    t = await createTestApp();
  });
  beforeEach(async () => {
    await resetDatabase();
    t.get(ReconciliationService).invalidate();
    await factoryAdmin(t.prisma);
    superAdmin = await createUser(t.prisma, { fullName: 'Sana Super', roles: ['SUPER_ADMIN'] });
    su = await loginAs(t, superAdmin);
  });
  afterAll(async () => {
    await t?.close();
    await disconnectTestPrisma();
  });

  function sale(programId: string, subjectUserId: string, overrides: Record<string, unknown> = {}) {
    return {
      programId,
      type: 'PRODUCT_SALE',
      externalId: `ORD-${++seq}`,
      customerReference: 'CUST-42',
      subjectUserId,
      amountMinor: '100000',
      occurredAt: new Date().toISOString(),
      ...overrides,
    };
  }

  const record = (client: LoggedInClient, body: Record<string, unknown>) => client.post('/api/v1/admin/events').send(body);

  /** A program whose annual plan costs ₹499.00 (49 900 minor). */
  const planProgram = () =>
    createProgram(t.prisma, {
      name: 'Annual plan program',
      options: [
        { name: 'Free', priceMinor: 0n },
        { name: 'Annual', priceMinor: 49_900n, billingFrequency: 'YEARLY', durationDays: 365 },
      ],
    });

  describe('F1 — a plan payment from one program is never a sale in another', () => {
    it('refuses the payment reference and the own-payment amount in every program of the currency (intake + DB)', async () => {
      const plans = await planProgram();
      const shop = await createProgram(t.prisma, { name: 'Shop program' });
      await createPolicy(t.prisma, { programId: shop.id });
      const sponsor = await createUser(t.prisma, { fullName: 'Sam Sponsor' });
      const member = await createUser(t.prisma, { fullName: 'Mia Member', sponsor });
      await createEnrollment(t.prisma, {
        userId: member.id,
        programId: plans.id,
        optionId: plans.options[1]!.id,
        paymentReference: 'UTR-PLAN-77',
        paymentAmountMinor: 49_900n,
      });

      // The plan payment id recorded as a sale of ANOTHER program (credited to someone else).
      const byReference = await record(su, sale(shop.id, sponsor.id, { externalId: 'UTR-PLAN-77', amountMinor: '120000' }));
      expect(byReference.status, JSON.stringify(byReference.body)).toBe(201);
      const refEvent = (byReference.body.data as RecordSaleResultDto).event;
      expect(refEvent).toMatchObject({ status: 'REJECTED', rewardCount: 0 });
      expect(refEvent.rejectionReason).toMatch(/member plan payment, not a sale/);

      // The member's own plan payment amount recorded as their sale in ANOTHER program.
      const byAmount = await record(su, sale(shop.id, member.id, { amountMinor: '49900' }));
      expect(byAmount.status).toBe(201);
      expect((byAmount.body.data as RecordSaleResultDto).event).toMatchObject({ status: 'REJECTED' });
      expect((byAmount.body.data as RecordSaleResultDto).event.rejectionReason).toMatch(/own plan payment/);

      // The database refuses both as RECEIVED sales, whatever the application does.
      await refusedByDb(
        createEvent(t.prisma, { programId: shop.id, subjectUserId: sponsor.id, externalId: 'UTR-PLAN-77' }),
        /member plan payment, not a sale/,
      );
      await refusedByDb(createEvent(t.prisma, { programId: shop.id, subjectUserId: member.id, amountMinor: 49_900n }), /own plan payment/);

      // A different amount is a normal sale.
      const fine = await record(su, sale(shop.id, member.id, { amountMinor: '50000' }));
      const fineEvent = (fine.body.data as RecordSaleResultDto).event;
      expect(fineEvent.status, fineEvent.rejectionReason ?? '').toBe('PROCESSED');
      expect(await t.prisma.rewardCalculation.count()).toBe(1);
    });
  });

  describe('F3 — back-dating a sale cannot escape the ±2-day window', () => {
    it('matches the own plan payment by the recording time when occurredAt is weeks earlier (intake + DB)', async () => {
      const plans = await planProgram();
      await createPolicy(t.prisma, { programId: plans.id });
      const sponsor = await createUser(t.prisma);
      const member = await createUser(t.prisma, { sponsor });
      await createEnrollment(t.prisma, { userId: member.id, programId: plans.id, optionId: plans.options[1]!.id, paymentAmountMinor: 49_900n });

      const backDated = new Date(Date.now() - 10 * DAY).toISOString();
      const res = await record(su, sale(plans.id, member.id, { amountMinor: '49900', occurredAt: backDated }));
      expect(res.status).toBe(201);
      const event = (res.body.data as RecordSaleResultDto).event;
      expect(event.status).toBe('REJECTED');
      expect(event.rejectionReason).toMatch(/own plan payment/);

      await refusedByDb(
        createEvent(t.prisma, { programId: plans.id, subjectUserId: member.id, amountMinor: 49_900n, occurredAt: new Date(Date.now() - 10 * DAY) }),
        /own plan payment/,
      );
      // A back-dated sale of a different amount is not a plan payment.
      const other = await createEvent(t.prisma, { programId: plans.id, subjectUserId: member.id, amountMinor: 49_901n, occurredAt: new Date(Date.now() - 10 * DAY) });
      expect(other.status).toBe('RECEIVED');
    });
  });

  describe("F2 — a recruit's plan payment recorded as the sponsor's sale", () => {
    /** Anita > Rahul > Priya; Priya (Rahul's recruit) paid ₹499.00 for the annual plan just now. */
    async function scenario(opts: { requiresApproval: boolean }) {
      const program = await planProgram();
      const policy = await createPolicy(t.prisma, {
        programId: program.id,
        requiresApproval: opts.requiresApproval,
        requireActiveEnrollment: false,
        rules: [{ level: 1, calcType: 'PERCENTAGE', percentageBps: 1000 }],
      });
      const anita = await createUser(t.prisma, { fullName: 'Anita Sharma' });
      const rahul = await createUser(t.prisma, { fullName: 'Rahul Verma', sponsor: anita });
      const priya = await createUser(t.prisma, { fullName: 'Priya Nair', sponsor: rahul });
      await createEnrollment(t.prisma, {
        userId: priya.id,
        programId: program.id,
        optionId: program.options[1]!.id,
        paymentReference: 'UTR-PRIYA-1',
        paymentAmountMinor: 49_900n,
      });
      const created = await su.post('/api/v1/admin/integrations/clients').send({ programId: program.id, name: 'Shop' });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const api = t.client().withoutCsrf().withHeaders({ Authorization: `Bearer ${created.body.data.apiKey as string}` });
      const ingest = (amountMinor: string, subjectUserId = rahul.id) =>
        api.post('/api/v1/integrations/events').send({
          type: 'PRODUCT_SALE',
          externalId: `INV-${++seq}`,
          customerReference: 'cust-1',
          subjectUserId,
          amountMinor,
          occurredAt: new Date().toISOString(),
        });
      return { program, policy, anita, rahul, priya, ingest };
    }

    it('is not hard-blocked, but its rewards wait for a reviewer even under an auto-approving policy', async () => {
      const { anita, rahul, priya, ingest } = await scenario({ requiresApproval: false });

      // Control: an unrelated amount from the same API client is approved and posted automatically.
      const normal = await ingest('50000');
      expect(normal.status, JSON.stringify(normal.body)).toBe(201);
      expect(await t.prisma.reward.findFirstOrThrow({ where: { eventId: normal.body.data.id } })).toMatchObject({ status: 'POSTED' });

      const res = await ingest('49900');
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data).toMatchObject({ status: 'PROCESSED', outcome: 'REWARDS_CREATED' });
      const eventId = res.body.data.id as string;
      const reward = await t.prisma.reward.findFirstOrThrow({ where: { eventId } });
      expect(reward).toMatchObject({ status: 'PENDING_APPROVAL', recipientUserId: anita.id, amountMinor: 4_990n });
      expect(await t.prisma.ledgerTransaction.count({ where: { rewardId: reward.id } })).toBe(0);

      // A flag on the credited member, once per sale.
      const flags = await t.prisma.memberFlag.findMany({ where: { kind: 'PLAN_PAYMENT_LOOKALIKE' } });
      expect(flags).toEqual([expect.objectContaining({ userId: rahul.id, status: 'OPEN', dedupeKey: `PLAN_PAYMENT_LOOKALIKE:${eventId}` })]);
      expect(flags[0]!.details).toMatch(new RegExp(priya.id));
      await t.get(RewardEngineService).processEvent(eventId); // idempotent: no second flag
      expect(await t.prisma.memberFlag.count({ where: { kind: 'PLAN_PAYMENT_LOOKALIKE' } })).toBe(1);

      // Reviewers see the warning on the sale, the reward detail and the queue row.
      const detail = (await su.get(`/api/v1/admin/events/${eventId}`).expect(200)).body.data as SaleEventDetailDto;
      expect(detail.compliance).toMatchObject({
        planPaymentLookalike: true,
        flag: { id: flags[0]!.id, status: 'OPEN' },
        matches: [expect.objectContaining({ relation: 'DOWNLINE', depth: 1, payer: { id: priya.id, fullName: 'Priya Nair' }, amountMinor: '49900' })],
      });
      expect(detail.compliance.message).toMatch(/downline/);
      const { client: finance } = await adminClient(t, ['FINANCE_REVIEWER']);
      const rewardDetail = (await finance.get(`/api/v1/admin/rewards/${reward.id}`).expect(200)).body.data as AdminRewardDetailDto;
      expect(rewardDetail.event.planPaymentLookalike).toBe(true);
      expect(rewardDetail.compliance.matches).toHaveLength(1);
      const rows = (await finance.get(`/api/v1/admin/rewards?status=PENDING_APPROVAL`).expect(200)).body.data as AdminRewardRowDto[];
      expect(rows.map((r) => [r.event.id, r.event.planPaymentLookalike])).toEqual([[eventId, true]]);
      const normalRow = (await finance.get(`/api/v1/admin/rewards?eventId=${normal.body.data.id}`).expect(200)).body.data[0] as AdminRewardRowDto;
      expect(normalRow.event.planPaymentLookalike).toBe(false);
      // A clean sale has nothing to review.
      const normalDetail = (await su.get(`/api/v1/admin/events/${normal.body.data.id}`).expect(200)).body.data as SaleEventDetailDto;
      expect(normalDetail.compliance).toEqual({ planPaymentLookalike: false, message: null, matches: [], flag: null });

      // Reconciliation queues the downline match for compliance review.
      const recon = t.get(ReconciliationService);
      let report = await recon.report(true);
      const queued = report.exceptions.filter((e) => e.check === 'PLAN_PAYMENT_LOOKALIKE');
      expect(queued).toEqual([
        expect.objectContaining({
          resourceId: eventId,
          details: expect.objectContaining({ relation: 'DOWNLINE', payerUserId: priya.id, depth: 1, subjectUserId: rahul.id }),
        }),
      ]);
      expect(report.healthy).toBe(true);

      // A reviewer may still approve it (four eyes) …
      await finance.post(`/api/v1/admin/rewards/${reward.id}/approve`).set('Idempotency-Key', idemKey()).expect(200);
      // … and dismissing the flag clears the review item.
      await su
        .post(`/api/v1/admin/flags/${flags[0]!.id}/resolve`)
        .send({ status: 'DISMISSED', resolution: 'Verified invoice from an end customer' })
        .expect(200);
      report = await recon.report(true);
      expect(report.exceptions.filter((e) => e.check === 'PLAN_PAYMENT_LOOKALIKE')).toEqual([]);
    });

    it('the database refuses an auto-approved reward for such a sale', async () => {
      const { policy, anita, rahul } = await scenario({ requiresApproval: false });
      const event = await createEvent(t.prisma, { programId: policy.programId, subjectUserId: rahul.id, source: 'API', amountMinor: 49_900n });
      await refusedByDb(
        processEventForTest(t.prisma, {
          eventId: event.id,
          policyVersionId: policy.id,
          rewards: [{ recipientUserId: anita.id, level: 1, amountMinor: 4_990n }],
          rewardStatus: 'APPROVED',
        }),
        /resembles a plan payment need human approval/,
      );
    });

    it('also flags manual sales (they need approval anyway) and keeps the sale processed', async () => {
      const { program, rahul } = await scenario({ requiresApproval: true });
      const res = await record(su, sale(program.id, rahul.id, { amountMinor: '49900' }));
      const event = (res.body.data as RecordSaleResultDto).event;
      expect(event).toMatchObject({ status: 'PROCESSED', outcome: 'REWARDS_CREATED' });
      expect(event.compliance.planPaymentLookalike).toBe(true);
      expect(event.rewards.map((r) => r.status)).toEqual(['PENDING_APPROVAL']);
      expect(await t.prisma.memberFlag.count({ where: { kind: 'PLAN_PAYMENT_LOOKALIKE', userId: rahul.id } })).toBe(1);
    });
  });

  describe('F4 — a POINTS sale whose base overflows bigint', () => {
    async function pointsProgram() {
      const program = await createProgram(t.prisma, { rewardUnit: 'POINTS' });
      const policy = await createPolicy(t.prisma, { programId: program.id, pointsPerCurrencyUnit: 1_000_000 });
      const anita = await createUser(t.prisma);
      const rahul = await createUser(t.prisma, { sponsor: anita });
      await createEnrollment(t.prisma, { userId: anita.id, programId: program.id });
      return { program, policy, anita, rahul };
    }

    it('is stored REJECTED with a reason at intake instead of staying RECEIVED forever', async () => {
      const { program, rahul } = await pointsProgram();
      const res = await record(su, sale(program.id, rahul.id, { amountMinor: '999999999999999999' }));
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const event = (res.body.data as RecordSaleResultDto).event;
      expect(event).toMatchObject({ status: 'REJECTED', outcome: 'REJECTED' });
      expect(event.rejectionReason).toMatch(/too large/);
      // The largest storable sale still works (base = amount × 10^6 / 100 ≤ 2^63 − 1).
      const max = await record(su, sale(program.id, rahul.id, { amountMinor: '922337203685477' }));
      expect((max.body.data as RecordSaleResultDto).event.status).toBe('PROCESSED');
    });

    it('the engine rejects an already-stored overflowing sale (e.g. recorded before the fix)', async () => {
      const { program, rahul } = await pointsProgram();
      const stuck = await createEvent(t.prisma, { programId: program.id, subjectUserId: rahul.id, amountMinor: 999_999_999_999_999_999n });
      const result = await t.get(RewardEngineService).processEvent(stuck.id);
      expect(result).toMatchObject({ outcome: 'REJECTED', rejectionReason: expect.stringMatching(/too large/) });
      expect(await t.prisma.qualifyingEvent.findUniqueOrThrow({ where: { id: stuck.id } })).toMatchObject({ status: 'REJECTED' });
      expect((await t.get(EventIntakeService).sweepStuck({ olderThanMs: 0 })).attempted).toBe(0);
    });

    it('an admin with events:reverse can reject a stuck RECEIVED sale so it can be re-recorded', async () => {
      const { program, rahul } = await pointsProgram();
      const stuck = await createEvent(t.prisma, { programId: program.id, subjectUserId: rahul.id, externalId: 'ORD-STUCK', amountMinor: 120_000n });
      const reason = 'Stuck in processing; re-recording with corrected data';

      const programAdmin = await adminClient(t, ['PROGRAM_ADMIN'], { programScopes: [program.id] });
      await programAdmin.client.post(`/api/v1/admin/events/${stuck.id}/reject`).set('Idempotency-Key', idemKey()).send({ reason }).expect(403);
      const { client: finance, user: reviewer } = await adminClient(t, ['FINANCE_REVIEWER']);
      await finance.post(`/api/v1/admin/events/${stuck.id}/reject`).set('Idempotency-Key', idemKey()).send({ reason: 'short' }).expect(400);
      const key = idemKey();
      const res = await finance.post(`/api/v1/admin/events/${stuck.id}/reject`).set('Idempotency-Key', key).send({ reason });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data as SaleEventDetailDto).toMatchObject({ id: stuck.id, status: 'REJECTED', outcome: 'REJECTED' });
      expect((res.body.data as SaleEventDetailDto).rejectionReason).toBe(`Rejected by an administrator: ${reason}`);
      const replay = await finance.post(`/api/v1/admin/events/${stuck.id}/reject`).set('Idempotency-Key', key).send({ reason });
      expect(replay.status).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(await t.prisma.auditLog.findFirst({ where: { action: 'event.reject', resourceId: stuck.id } })).toMatchObject({
        actorUserId: reviewer.id,
        programId: program.id,
        reason,
      });
      const again = await finance.post(`/api/v1/admin/events/${stuck.id}/reject`).set('Idempotency-Key', idemKey()).send({ reason });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');

      // The same external id is re-recorded as revision 1.
      const rerecord = await record(su, sale(program.id, rahul.id, { externalId: 'ORD-STUCK', amountMinor: '120000' }));
      expect(rerecord.status, JSON.stringify(rerecord.body)).toBe(201);
      expect((rerecord.body.data as RecordSaleResultDto).event).toMatchObject({ revision: 1, supersedesEventId: stuck.id, status: 'PROCESSED' });

      // A processed sale cannot be "rejected" (reverse it instead).
      const processedId = (rerecord.body.data as RecordSaleResultDto).event.id;
      const processed = await finance.post(`/api/v1/admin/events/${processedId}/reject`).set('Idempotency-Key', idemKey()).send({ reason });
      expect(processed.status).toBe(409);
      expect(processed.body.error.message).toMatch(/Reverse it instead/);
    });
  });
});
