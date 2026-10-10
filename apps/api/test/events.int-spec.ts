import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordSaleResultDto, SaleEventDetailDto, SaleEventDto, SaleProgramOptionDto } from '@app/shared';
import { EventIntakeService } from '../src/modules/events/event-intake.service';
import { EVENTS_SWEEPER_JOB } from '../src/modules/events/events.jobs';
import { RewardEngineService } from '../src/modules/rewards/reward-engine.service';
import { ScheduledJobsRegistry } from '../src/jobs/scheduler/scheduled-jobs.registry';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import {
  createApiClient,
  createEnrollment,
  createEvent,
  createPolicy,
  createProgram,
  createUser,
  factoryAdmin,
  loginAs,
  type LoggedInClient,
  type TestUser,
} from './utils/factories';

describe('sales intake (business rules §8)', () => {
  let t: TestApp;
  let su: LoggedInClient;
  let superAdmin: TestUser;
  let seq = 0;

  beforeAll(async () => {
    t = await createTestApp();
  });
  beforeEach(async () => {
    await resetDatabase();
    await factoryAdmin(t.prisma);
    superAdmin = await createUser(t.prisma, { fullName: 'Sana Super', roles: ['SUPER_ADMIN'] });
    su = await loginAs(t, superAdmin);
  });
  afterAll(async () => {
    await t.close();
    await disconnectTestPrisma();
  });

  /** Anita > Rahul > Priya, uplines enrolled, program with the default 10% / 5% policy. */
  async function setup(opts: { policy?: boolean } = {}) {
    const program = await createProgram(t.prisma);
    const anita = await createUser(t.prisma, { fullName: 'Anita Sharma' });
    const rahul = await createUser(t.prisma, { fullName: 'Rahul Verma', sponsor: anita });
    const priya = await createUser(t.prisma, { fullName: 'Priya Nair', sponsor: rahul });
    for (const u of [anita, rahul]) await createEnrollment(t.prisma, { userId: u.id, programId: program.id });
    const policy = opts.policy === false ? null : await createPolicy(t.prisma, { programId: program.id });
    return { program, anita, rahul, priya, policy };
  }

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

  async function record(client: LoggedInClient, body: Record<string, unknown>, headers: Record<string, string> = {}) {
    let req = client.post('/api/v1/admin/events');
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    return req.send(body);
  }

  describe('recording', () => {
    it('records a sale, runs the engine and returns the outcome with the trace', async () => {
      const { program, anita, rahul, priya, policy } = await setup();
      const res = await record(su, sale(program.id, priya.id, { description: 'Invoice 42' }));
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const body = res.body.data as RecordSaleResultDto;
      expect(body).toMatchObject({ outcome: 'REWARDS_CREATED', replayed: false });
      expect(body.event).toMatchObject({
        status: 'PROCESSED',
        source: 'ADMIN_MANUAL',
        revision: 0,
        amountMinor: '100000',
        currencyCode: 'INR',
        description: 'Invoice 42',
        policyVersionId: policy!.id,
        policyVersion: 1,
        recordedBy: { id: superAdmin.id },
        subject: { id: priya.id, fullName: 'Priya Nair' },
        rewardCount: 2,
        rewardTotalMinor: '15000',
      });
      expect(body.event.rewards.map((r) => [r.level, r.recipient.id, r.amountMinor, r.status])).toEqual([
        [1, rahul.id, '10000', 'PENDING_APPROVAL'],
        [2, anita.id, '5000', 'PENDING_APPROVAL'],
      ]);
      expect(body.event.calculation).toMatchObject({ budgetMinor: '20000', totalAllocatedMinor: '15000' });
      expect(body.event.calculation!.ancestors.map((a) => [a.fullName, a.eligible])).toEqual([
        ['Rahul Verma', true],
        ['Anita Sharma', true],
      ]);
      expect(body.event.calculation!.steps.some((s) => s.step === 'level' && s.decision === 'AWARDED')).toBe(true);

      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'event.record', resourceId: body.event.id } });
      expect(audit).toMatchObject({ actorUserId: superAdmin.id, programId: program.id });
    });

    it('replays an identical request and refuses different facts without echoing them', async () => {
      const { program, priya } = await setup();
      const body = sale(program.id, priya.id);
      const first = await record(su, body);
      expect(first.status).toBe(201);
      const again = await record(su, { ...body, description: 'descriptions are not part of the sale facts' });
      expect(again.status).toBe(200);
      expect(again.body.data).toMatchObject({ replayed: true, event: { id: first.body.data.event.id } });

      const different = await record(su, { ...body, amountMinor: '100001' });
      expect(different.status).toBe(409);
      expect(different.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(different.body.error.details).toBeUndefined();
      expect(JSON.stringify(different.body)).not.toContain(first.body.data.event.id);
      expect(await t.prisma.qualifyingEvent.count()).toBe(1);
      expect(await t.prisma.reward.count()).toBe(2);
    });

    it('honours the Idempotency-Key header and serializes concurrent duplicates', async () => {
      const { program, priya } = await setup();
      const body = sale(program.id, priya.id);
      const key = 'sale-key-0001';
      const a = await record(su, body, { 'Idempotency-Key': key });
      const b = await record(su, body, { 'Idempotency-Key': key });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(b.headers['idempotent-replayed']).toBe('true');
      expect(b.body.data.event.id).toBe(a.body.data.event.id);

      const concurrent = sale(program.id, priya.id);
      const results = await Promise.all([record(su, concurrent), record(su, concurrent), record(su, concurrent)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
      expect(new Set(results.map((r) => r.body.data.event.id)).size).toBe(1);
      expect(await t.prisma.qualifyingEvent.count({ where: { externalId: concurrent.externalId } })).toBe(1);
    });

    it('rejects invalid requests that cannot be stored', async () => {
      const { program, priya } = await setup();
      const currency = await record(su, sale(program.id, priya.id, { currencyCode: 'USD' }));
      expect(currency.status).toBe(400);
      expect(currency.body.error.details.issues[0].path).toBe('currencyCode');
      const unknown = await record(su, sale(program.id, '00000000-0000-4000-8000-000000000000'));
      expect(unknown.status).toBe(400);
      expect(unknown.body.error.details.issues[0].path).toBe('subjectUserId');
      expect((await record(su, sale(program.id, priya.id, { amountMinor: '0' }))).status).toBe(400);
      expect((await record(su, sale(program.id, priya.id, { customerReference: '  ' }))).status).toBe(400);
      expect((await record(su, sale(program.id, priya.id, { type: 'ENROLLMENT' }))).status).toBe(400);
      expect(await t.prisma.qualifyingEvent.count()).toBe(0);
    });
  });

  describe('intake rules', () => {
    it('stores business-rule failures as REJECTED with a reason', async () => {
      const { program, priya, rahul } = await setup();
      const cases: Array<[Record<string, unknown>, RegExp]> = [
        [{ occurredAt: new Date(Date.now() + 3_600_000).toISOString() }, /in the future/],
        [{ occurredAt: new Date(Date.now() - 40 * 86_400_000).toISOString() }, /outside the program period/],
        // The program became ACTIVE when it was created (now): a sale an hour earlier predates it.
        [{ occurredAt: new Date(Date.now() - 3_600_000).toISOString() }, /not active when the sale occurred/],
        [{ type: 'SERVICE_COMPLETED' }, /does not reward SERVICE_COMPLETED/],
      ];
      for (const [overrides, reason] of cases) {
        const res = await record(su, sale(program.id, priya.id, overrides));
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body.data.outcome).toBe('REJECTED');
        expect(res.body.data.event.status).toBe('REJECTED');
        expect(res.body.data.event.rejectionReason).toMatch(reason);
      }

      await t.prisma.user.update({ where: { id: rahul.id }, data: { status: 'SUSPENDED', suspendedAt: new Date() } });
      const suspended = await record(su, sale(program.id, rahul.id));
      expect(suspended.body.data.event.rejectionReason).toMatch(/not an active member/);

      await t.prisma.offering.update({ where: { id: program.offeringId }, data: { status: 'INACTIVE' } });
      const inactive = await record(su, sale(program.id, priya.id));
      expect(inactive.status).toBe(201);
      expect(inactive.body.data.event.rejectionReason).toMatch(/offering is not approved/);
      expect(await t.prisma.reward.count()).toBe(0);
    });

    it('rejects a sale when no policy applies, and re-records it as a new revision', async () => {
      const { program, priya } = await setup({ policy: false });
      const body = sale(program.id, priya.id);
      const first = await record(su, body);
      expect(first.body.data.event).toMatchObject({ status: 'REJECTED', rejectionReason: 'No reward policy applies to the sale date' });
      const rejectedId = first.body.data.event.id as string;

      await createPolicy(t.prisma, { programId: program.id, effectiveFrom: new Date(new Date(body.occurredAt).getTime() - 1_000) });
      // The identical request is a replay of the rejected record…
      const replay = await record(su, body);
      expect(replay.status).toBe(200);
      expect(replay.body.data.event.id).toBe(rejectedId);
      // …an explicit re-record supersedes it.
      const rerecord = await record(su, { ...body, supersedesEventId: rejectedId });
      expect(rerecord.status, JSON.stringify(rerecord.body)).toBe(201);
      expect(rerecord.body.data).toMatchObject({
        outcome: 'REWARDS_CREATED',
        event: { revision: 1, supersedesEventId: rejectedId, status: 'PROCESSED' },
      });
      const detail = await su.get(`/api/v1/admin/events/${rejectedId}`);
      expect(detail.body.data).toMatchObject({ supersededByEventId: rerecord.body.data.event.id });
      expect((detail.body.data as SaleEventDetailDto).revisions.map((r) => [r.revision, r.status])).toEqual([
        [0, 'REJECTED'],
        [1, 'PROCESSED'],
      ]);

      // The live revision cannot be superseded; a stale supersede is refused.
      const notSupersedable = await record(su, { ...body, amountMinor: '5000', supersedesEventId: rerecord.body.data.event.id });
      expect(notSupersedable.status).toBe(409);
      expect(notSupersedable.body.error.code).toBe('INVALID_STATE_TRANSITION');
      const stale = await record(su, { ...body, amountMinor: '5000', supersedesEventId: rejectedId });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('CONFLICT');
    });

    it('a corrected request supersedes a rejected sale implicitly', async () => {
      const { program, priya } = await setup();
      const bad = await record(su, sale(program.id, priya.id, { externalId: 'ORD-FIX', type: 'SERVICE_COMPLETED' }));
      expect(bad.body.data.outcome).toBe('REJECTED');
      const fixed = await record(su, sale(program.id, priya.id, { externalId: 'ORD-FIX' }));
      expect(fixed.status).toBe(201);
      expect(fixed.body.data.event).toMatchObject({ revision: 1, supersedesEventId: bad.body.data.event.id, status: 'PROCESSED' });
    });

    it('never treats a member plan payment as a sale', async () => {
      const program = await createProgram(t.prisma, { options: [{ priceMinor: 49_900n, durationDays: 365 }] });
      await createPolicy(t.prisma, { programId: program.id });
      const sponsor = await createUser(t.prisma);
      const member = await createUser(t.prisma, { sponsor });
      await createEnrollment(t.prisma, { userId: member.id, programId: program.id, paymentReference: 'PAY-0001', paymentAmountMinor: 49_900n });

      const byReference = await record(su, sale(program.id, member.id, { externalId: 'PAY-0001', amountMinor: '120000' }));
      expect(byReference.status).toBe(201);
      expect(byReference.body.data.event.rejectionReason).toMatch(/member plan payment, not a sale/);

      const byAmount = await record(su, sale(program.id, member.id, { amountMinor: '49900' }));
      expect(byAmount.body.data.event.rejectionReason).toMatch(/own plan payment/);
      // Another member's sale of the same amount is fine.
      const other = await record(su, sale(program.id, sponsor.id, { amountMinor: '49900' }));
      expect(other.body.data.event.status).not.toBe('REJECTED');
    });

    it('refuses sales recorded by an admin for themselves or their downline (friendly 409)', async () => {
      const { program, priya } = await setup();
      const admin = await createUser(t.prisma, { fullName: 'Pat Admin', roles: ['PROGRAM_ADMIN'], programScopes: [program.id] });
      const downline = await createUser(t.prisma, { sponsor: admin });
      const pa = await loginAs(t, admin);

      const own = await record(pa, sale(program.id, admin.id));
      expect(own.status).toBe(409);
      expect(own.body.error).toMatchObject({ code: 'CONFLICT', details: { reason: 'RECORDER_SOD' } });
      expect(own.body.error.message).toMatch(/yourself/);
      const team = await record(pa, sale(program.id, downline.id));
      expect(team.status).toBe(409);
      expect(team.body.error.message).toMatch(/downline/);
      expect((await record(pa, sale(program.id, priya.id))).status).toBe(201);
      expect(await t.prisma.qualifyingEvent.count({ where: { recordedById: admin.id } })).toBe(1);
    });
  });

  describe('channels and programs', () => {
    it('treats the same sale sent through the API as a duplicate of the admin record', async () => {
      const { program, priya } = await setup();
      const body = sale(program.id, priya.id);
      const admin = await record(su, body);
      expect(admin.status).toBe(201);

      const created = await su.post('/api/v1/admin/integrations/clients').send({ programId: program.id, name: 'Shop' });
      const apiKey = created.body.data.apiKey as string;
      const api = t.client().withoutCsrf().withHeaders({ Authorization: `Bearer ${apiKey}` });
      const { programId: _omit, ...apiBody } = body;
      void _omit;
      const dup = await api.post('/api/v1/integrations/events').send(apiBody);
      expect(dup.status, JSON.stringify(dup.body)).toBe(200);
      expect(dup.body.data).toMatchObject({ id: admin.body.data.event.id, replayed: true, status: 'PROCESSED' });

      const conflict = await api.post('/api/v1/integrations/events').send({ ...apiBody, amountMinor: '1' });
      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(await t.prisma.qualifyingEvent.count()).toBe(1);
    });

    it('refuses the same sale in another program sharing the offering', async () => {
      const { program, priya } = await setup();
      const sibling = await createProgram(t.prisma, { offeringId: program.offeringId });
      await createPolicy(t.prisma, { programId: sibling.id });
      const body = sale(program.id, priya.id);
      expect((await record(su, body)).status).toBe(201);
      const other = await record(su, { ...body, programId: sibling.id });
      expect(other.status).toBe(409);
      expect(other.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('scopes recording, lists and details to the admin programs', async () => {
      const { program, priya } = await setup();
      const other = await createProgram(t.prisma);
      const pa = await loginAs(t, await createUser(t.prisma, { roles: ['PROGRAM_ADMIN'], programScopes: [program.id] }));
      const fin = await loginAs(t, await createUser(t.prisma, { roles: ['FINANCE_REVIEWER'] }));
      const otherEvent = await createEvent(t.prisma, { programId: other.id, subjectUserId: priya.id });

      expect((await record(pa, sale(other.id, priya.id))).status).toBe(403);
      expect((await record(fin, sale(program.id, priya.id))).status).toBe(403);
      const mine = await record(pa, sale(program.id, priya.id, { amountMinor: '250000' }));
      expect(mine.status).toBe(201);

      const listed = await pa.get('/api/v1/admin/events');
      expect(listed.status).toBe(200);
      expect((listed.body.data as SaleEventDto[]).map((e) => e.id)).toEqual([mine.body.data.event.id]);
      expect(listed.body.data[0]).toMatchObject({ rewardCount: 2, rewardTotalMinor: '37500', outcome: 'REWARDS_CREATED' });
      expect((await pa.get(`/api/v1/admin/events/${otherEvent.id}`)).status).toBe(403);
      expect((await pa.get(`/api/v1/admin/events?programId=${other.id}`)).status).toBe(403);

      const all = await fin.get('/api/v1/admin/events?limit=1');
      expect(all.body.data).toHaveLength(1);
      expect(all.body.page.nextCursor).toEqual(expect.any(String));
      const page2 = await fin.get(`/api/v1/admin/events?limit=1&cursor=${all.body.page.nextCursor}`);
      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.data[0].id).not.toBe(all.body.data[0].id);
      expect((await fin.get(`/api/v1/admin/events?status=RECEIVED`)).body.data.map((e: SaleEventDto) => e.id)).toEqual([otherEvent.id]);
      expect((await fin.get(`/api/v1/admin/events?q=${otherEvent.externalId}`)).body.data).toHaveLength(1);
      expect((await fin.get('/api/v1/admin/events?cursor=bad!')).status).toBe(400);

      const options = (await pa.get('/api/v1/admin/events/programs')).body.data as SaleProgramOptionDto[];
      expect(options.map((o) => [o.id, o.canRecordSales])).toEqual([[program.id, true]]);
      const finOptions = (await fin.get('/api/v1/admin/events/programs')).body.data as SaleProgramOptionDto[];
      expect(finOptions).toHaveLength(2);
      expect(finOptions.every((o) => !o.canRecordSales)).toBe(true);
    });
  });

  describe('recordable programs', () => {
    it('offers finished programs for late sales only if they ran (a cancelled scheduled program never did)', async () => {
      const inFiveDays = new Date(Date.now() + 5 * 86_400_000);
      await createProgram(t.prisma, { status: 'COMPLETED', name: 'Completed' });
      await createProgram(t.prisma, { status: 'SCHEDULED', name: 'Scheduled', startsAt: inFiveDays });
      const cancelled = await createProgram(t.prisma, { status: 'SCHEDULED', name: 'Cancelled', startsAt: inFiveDays });
      await su.post(`/api/v1/admin/programs/${cancelled.id}/cancel`).send({ reason: 'Launch postponed by the supplier' }).expect(200);

      const options = (await su.get('/api/v1/admin/events/programs').expect(200)).body.data as SaleProgramOptionDto[];
      expect(Object.fromEntries(options.map((o) => [o.name, [o.status, o.canRecordSales]]))).toEqual({
        Completed: ['COMPLETED', true],
        Scheduled: ['SCHEDULED', false],
        Cancelled: ['ARCHIVED', false],
      });
    });
  });

  describe('sweeper', () => {
    it('processes events stuck in RECEIVED for more than two minutes', async () => {
      const { program, priya } = await setup();
      const stuck = await createEvent(t.prisma, { programId: program.id, subjectUserId: priya.id });
      const intake = t.get(EventIntakeService);

      // Fresh events are left alone (the scheduled job uses the real clock).
      await t.get(ScheduledJobsRegistry).runNow(EVENTS_SWEEPER_JOB);
      expect((await t.prisma.qualifyingEvent.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe('RECEIVED');

      const result = await intake.sweepStuck({ now: new Date(Date.now() + 3 * 60_000) });
      expect(result).toEqual({ attempted: 1, processed: 1 });
      expect((await t.prisma.qualifyingEvent.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe('PROCESSED');
      expect(await t.prisma.reward.count({ where: { eventId: stuck.id } })).toBe(2);
      expect(await intake.sweepStuck({ now: new Date(Date.now() + 3 * 60_000) })).toEqual({ attempted: 0, processed: 0 });
    });

    it('keeps the sale when the engine fails after commit (PENDING), then the sweeper completes it', async () => {
      const { program, priya } = await setup();
      const engine = t.get(RewardEngineService);
      const spy = vi.spyOn(engine, 'processEvent').mockRejectedValueOnce(new Error('engine unavailable'));
      try {
        const res = await record(su, sale(program.id, priya.id));
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ outcome: 'PENDING', event: { status: 'RECEIVED', rewardCount: 0 } });
      } finally {
        spy.mockRestore();
      }
      const result = await t.get(EventIntakeService).sweepStuck({ now: new Date(Date.now() + 3 * 60_000) });
      expect(result.processed).toBe(1);
      expect(await t.prisma.reward.count()).toBe(2);
    });
  });

  it('keeps the factory api client helper compatible with ingestion', async () => {
    // Keys created outside the admin API (e.g. migrated clients) authenticate by hash as well.
    const { program, priya } = await setup();
    const client = await createApiClient(t.prisma, program.id);
    const api = t.client().withoutCsrf().withHeaders({ Authorization: `Bearer ${client.apiKey}` });
    const { programId: _p, ...body } = sale(program.id, priya.id);
    void _p;
    const res = await api.post('/api/v1/integrations/events').send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ outcome: 'REWARDS_CREATED', replayed: false, programId: program.id });
  });
});
