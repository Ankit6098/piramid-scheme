import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ScheduledJobsRegistry } from '../src/jobs/scheduler/scheduled-jobs.registry';
import { ENROLLMENT_EXPIRY_JOB } from '../src/modules/enrollments/enrollments.jobs';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import {
  createEnrollment,
  createEvent,
  createProgram,
  createUser,
  factoryAdmin,
  loginAs,
  type CreateProgramOptions,
  type LoggedInClient,
  type TestUser,
} from './utils/factories';

const DAY = 86_400_000;
const ADMIN = '/api/v1/admin/enrollments';
const MINE = '/api/v1/users/me/enrollments';
const REASON = 'Payment could not be verified with the bank';

describe('enrollments (business rules §5)', () => {
  let t: TestApp;
  let superAdmin: TestUser;
  let sa: LoggedInClient;

  beforeAll(async () => {
    t = await createTestApp();
  });
  beforeEach(async () => {
    await resetDatabase();
    superAdmin = await factoryAdmin(t.prisma);
    sa = await loginAs(t, superAdmin);
  });
  afterAll(async () => {
    await t?.close();
    await disconnectTestPrisma();
  });

  const enrollUrl = (programId: string) => `/api/v1/programs/${programId}/enrollments`;

  async function member(opts: Parameters<typeof createUser>[1] = {}) {
    const user = await createUser(t.prisma, opts);
    return { user, c: await loginAs(t, user) };
  }

  /** ACTIVE program with a free plan (index 0) and a paid plan (index 1). */
  async function program(opts: CreateProgramOptions = {}) {
    return createProgram(t.prisma, {
      status: 'ACTIVE',
      options: [
        { name: 'Starter', priceMinor: 0n, billingFrequency: 'MONTHLY', durationDays: 30 },
        { name: 'Annual', priceMinor: 120_000n, billingFrequency: 'YEARLY', durationDays: 365 },
      ],
      ...opts,
    });
  }

  /**
   * Test-only: inserts an ACTIVE enrollment whose coverage already started/ended. The DB refuses
   * back-dated coverage (insert guard), so the guard is disabled for this one INSERT inside the
   * transaction (DDL is transactional; the dedicated test database is not shared).
   */
  async function backdated(userId: string, programId: string, optionId: string, from: Date, to: Date) {
    return t.prisma.$transaction(async (tx) => {
      const option = await tx.programOption.findUniqueOrThrow({ where: { id: optionId } });
      await tx.$executeRawUnsafe('ALTER TABLE "program_enrollments" DISABLE TRIGGER "trg_enrollments_insert_guard"');
      const row = await tx.programEnrollment.create({
        data: {
          userId,
          programId,
          optionId,
          optionSnapshot: {
            optionId,
            name: option.name,
            priceMinor: option.priceMinor.toString(),
            currencyCode: option.currencyCode,
            billingFrequency: option.billingFrequency,
            durationDays: option.durationDays,
            renewalPolicy: option.renewalPolicy,
          },
          termsVersion: '1.0',
          status: 'ACTIVE',
          eligibilityStatus: 'ELIGIBLE',
          effectiveFrom: from,
          effectiveTo: to,
        },
      });
      await tx.$executeRawUnsafe('ALTER TABLE "program_enrollments" ENABLE TRIGGER "trg_enrollments_insert_guard"');
      return row;
    });
  }

  describe('member catalogue', () => {
    it('lists browsable programs with active plans, window info and the caller’s eligibility', async () => {
      const visible = await program({ eligibility: { requireSponsor: true } });
      await createProgram(t.prisma, { status: 'DRAFT' });
      await createProgram(t.prisma, { status: 'PAUSED' });
      await createProgram(t.prisma, { status: 'ACTIVE', options: [{ isActive: false }] });
      const scheduled = await createProgram(t.prisma, { status: 'SCHEDULED', startsAt: new Date(Date.now() + 5 * DAY) });
      const { c } = await member();
      const res = await c.get('/api/v1/programs').expect(200);
      expect(res.body.data.map((p: { id: string }) => p.id).sort()).toEqual([visible.id, scheduled.id].sort());
      const card = res.body.data.find((p: { id: string }) => p.id === visible.id);
      expect(card).toMatchObject({
        enrollmentOpen: true,
        currencyCode: 'INR',
        myEligibility: { eligible: false, reasons: [expect.stringMatching(/referral/)] },
        options: [
          expect.objectContaining({ name: 'Starter', priceMinor: '0' }),
          expect.objectContaining({ name: 'Annual', priceMinor: '120000' }),
        ],
        myEnrollments: [],
      });
      expect(card).not.toHaveProperty('rewardUnit');
      expect(res.body.data.find((p: { id: string }) => p.id === scheduled.id).enrollmentOpen).toBe(false);
    });

    it('shows a program by id or code; drafts never, paused only to enrolled members', async () => {
      const p = await program({ code: 'water-club' });
      const { user, c } = await member();
      expect((await c.get('/api/v1/programs/water-club').expect(200)).body.data.id).toBe(p.id);
      await c.get(`/api/v1/programs/${p.id}`).expect(200);
      const draft = await createProgram(t.prisma, { status: 'DRAFT' });
      await c.get(`/api/v1/programs/${draft.id}`).expect(404);
      await createEnrollment(t.prisma, { userId: user.id, programId: p.id });
      await t.prisma.program.update({ where: { id: p.id }, data: { status: 'PAUSED', updatedById: superAdmin.id } });
      await c.get(`/api/v1/programs/${p.id}`).expect(200);
      const stranger = await member();
      await stranger.c.get(`/api/v1/programs/${p.id}`).expect(404);
    });
  });

  describe('enroll', () => {
    it('activates a free plan immediately with a snapshot, audit and notification', async () => {
      const p = await program();
      const sponsor = await createUser(t.prisma);
      const { user, c } = await member({ sponsor });
      const res = await c.post(enrollUrl(p.id)).send({ optionId: p.options[0]!.id, acceptTerms: true, termsVersion: '1.0' }).expect(201);
      const e = res.body.data;
      expect(e).toMatchObject({
        status: 'ACTIVE',
        eligibilityStatus: 'ELIGIBLE',
        upcoming: false,
        canCancel: true,
        option: { optionId: p.options[0]!.id, name: 'Starter', priceMinor: '0', currencyCode: 'INR', billingFrequency: 'MONTHLY', durationDays: 30 },
        program: { id: p.id, currencyCode: 'INR' },
      });
      expect(Date.parse(e.effectiveTo) - Date.parse(e.effectiveFrom)).toBe(30 * DAY);
      const row = await t.prisma.programEnrollment.findUniqueOrThrow({ where: { id: e.id } });
      expect(row.sponsorUserId).toBe(sponsor.id);
      expect((row.optionSnapshot as { priceMinor: unknown }).priceMinor).toBe('0');
      expect(await t.prisma.auditLog.count({ where: { action: 'enrollment.create', programId: p.id, actorUserId: user.id } })).toBe(1);
      const notice = await t.prisma.outboxMessage.findFirstOrThrow({ where: { topic: 'notification.create' } });
      expect(notice.payload).toMatchObject({ userId: user.id, type: 'enrollment.activated' });
    });

    it('creates a PENDING enrollment for a paid plan and refuses a second pending one', async () => {
      const p = await program();
      const { c } = await member();
      const res = await c.post(enrollUrl(p.id)).send({ optionId: p.options[1]!.id, acceptTerms: true }).expect(201);
      expect(res.body.data).toMatchObject({ status: 'PENDING', eligibilityStatus: 'PENDING_REVIEW', effectiveFrom: null, option: { priceMinor: '120000' } });
      const again = await c.post(enrollUrl(p.id)).send({ optionId: p.options[0]!.id, acceptTerms: true }).expect(409);
      expect(again.body.error.code).toBe('ALREADY_ENROLLED');
    });

    it('validates terms acceptance, terms version and the plan', async () => {
      const p = await program();
      const { c } = await member();
      await c.post(enrollUrl(p.id)).send({ optionId: p.options[0]!.id }).expect(400);
      await c.post(enrollUrl(p.id)).send({ optionId: p.options[0]!.id, acceptTerms: false }).expect(400);
      const terms = await c.post(enrollUrl(p.id)).send({ optionId: p.options[0]!.id, acceptTerms: true, termsVersion: '0.9' }).expect(409);
      expect(terms.body.error.code).toBe('CONFLICT');
      const other = await program();
      const bad = await c.post(enrollUrl(p.id)).send({ optionId: other.options[0]!.id, acceptTerms: true }).expect(400);
      expect(bad.body.error.details.issues[0].path).toBe('optionId');
    });

    it('requires an ACTIVE program with an open enrollment window', async () => {
      const { c } = await member();
      const notYet = await program({ enrollmentOpensAt: new Date(Date.now() + DAY) });
      expect((await c.post(enrollUrl(notYet.id)).send({ optionId: notYet.options[0]!.id, acceptTerms: true }).expect(409)).body.error.code).toBe(
        'PROGRAM_NOT_ENROLLABLE',
      );
      const paused = await program({ status: 'PAUSED' });
      await c.post(enrollUrl(paused.id)).send({ optionId: paused.options[0]!.id, acceptTerms: true }).expect(409);
      const draft = await program({ status: 'DRAFT' });
      await c.post(enrollUrl(draft.id)).send({ optionId: draft.options[0]!.id, acceptTerms: true }).expect(404);
    });

    it('applies the program eligibility rules', async () => {
      const p = await program({ eligibility: { requireSponsor: true, minAccountAgeDays: 0 } });
      const lone = await member();
      const res = await lone.c.post(enrollUrl(p.id)).send({ optionId: p.options[0]!.id, acceptTerms: true }).expect(409);
      expect(res.body.error).toMatchObject({ code: 'NOT_ELIGIBLE', details: { reasons: [expect.any(String)] } });
      const sponsored = await member({ sponsor: await createUser(t.prisma) });
      await sponsored.c.post(enrollUrl(p.id)).send({ optionId: p.options[0]!.id, acceptTerms: true }).expect(201);

      const aged = await program({ eligibility: { minAccountAgeDays: 30 } });
      const fresh = await member();
      await fresh.c.post(enrollUrl(aged.id)).send({ optionId: aged.options[0]!.id, acceptTerms: true }).expect(409);
      const old = await member({ createdAt: new Date(Date.now() - 40 * DAY) });
      await old.c.post(enrollUrl(aged.id)).send({ optionId: aged.options[0]!.id, acceptTerms: true }).expect(201);
    });

    it('renews a free plan without a gap and allows only one queued renewal', async () => {
      const p = await program();
      const { c } = await member();
      const first = (await c.post(enrollUrl(p.id)).send({ optionId: p.options[0]!.id, acceptTerms: true }).expect(201)).body.data;
      const renewal = (await c.post(enrollUrl(p.id)).send({ optionId: p.options[0]!.id, acceptTerms: true }).expect(201)).body.data;
      expect(renewal).toMatchObject({ status: 'ACTIVE', upcoming: true, effectiveFrom: first.effectiveTo });
      const third = await c.post(enrollUrl(p.id)).send({ optionId: p.options[0]!.id, acceptTerms: true }).expect(409);
      expect(third.body.error.code).toBe('ALREADY_ENROLLED');
    });

    it('refuses renewing a plan whose renewal policy is NONE', async () => {
      const p = await program();
      const once = await sa
        .post(`/api/v1/admin/programs/${p.id}/options`)
        .send({ name: 'Once', priceMinor: '0', billingFrequency: 'ONE_TIME', durationDays: 10, renewalPolicy: 'NONE' })
        .expect(201);
      const { c } = await member();
      await c.post(enrollUrl(p.id)).send({ optionId: once.body.data.id, acceptTerms: true }).expect(201);
      const res = await c.post(enrollUrl(p.id)).send({ optionId: p.options[0]!.id, acceptTerms: true }).expect(409);
      expect(res.body.error.message).toMatch(/cannot be renewed/);
    });

    it('lists only the caller’s enrollments', async () => {
      const p = await program();
      const a = await member();
      const b = await member();
      await a.c.post(enrollUrl(p.id)).send({ optionId: p.options[0]!.id, acceptTerms: true }).expect(201);
      await b.c.post(enrollUrl(p.id)).send({ optionId: p.options[1]!.id, acceptTerms: true }).expect(201);
      const mine = await a.c.get(MINE).expect(200);
      expect(mine.body.data).toHaveLength(1);
      expect(mine.body.data[0].status).toBe('ACTIVE');
      expect(mine.body.data[0]).not.toHaveProperty('paymentReference');
      expect((await b.c.get(`${MINE}?status=ACTIVE`).expect(200)).body.data).toHaveLength(0);
    });
  });

  describe('admin activation and rejection', () => {
    async function pendingPaid() {
      const p = await program();
      const m = await member();
      const e = (await m.c.post(enrollUrl(p.id)).send({ optionId: p.options[1]!.id, acceptTerms: true }).expect(201)).body.data;
      return { p, m, e };
    }

    it('activates with an offline payment record (scoped), notifying the member', async () => {
      const { p, m, e } = await pendingPaid();
      const outsider = await createUser(t.prisma, { roles: ['PROGRAM_ADMIN'], programScopes: [(await program()).id] });
      const oc = await loginAs(t, outsider);
      await oc.post(`${ADMIN}/${e.id}/activate`).send({ paymentReference: 'UTR-1001', paymentAmountMinor: '120000' }).expect(403);
      await oc.get(`${ADMIN}/${e.id}`).expect(403);

      const owner = await createUser(t.prisma, { roles: ['PROGRAM_ADMIN'], programScopes: [p.id] });
      const c = await loginAs(t, owner);
      const short = await c.post(`${ADMIN}/${e.id}/activate`).send({ paymentReference: 'UTR-1001', paymentAmountMinor: '1000' }).expect(400);
      expect(short.body.error.details.issues[0].path).toBe('paymentAmountMinor');
      const res = await c.post(`${ADMIN}/${e.id}/activate`).send({ paymentReference: 'UTR-1001', paymentAmountMinor: '120000' }).expect(200);
      expect(res.body.data).toMatchObject({
        status: 'ACTIVE',
        eligibilityStatus: 'ELIGIBLE',
        paymentReference: 'UTR-1001',
        paymentAmountMinor: '120000',
        paymentRecordedBy: { id: owner.id },
        member: { id: m.user.id },
        allowedActions: ['cancel'],
      });
      expect(Date.parse(res.body.data.effectiveTo) - Date.parse(res.body.data.effectiveFrom)).toBe(365 * DAY);
      expect(await t.prisma.outboxMessage.count({ where: { topic: 'email.send' } })).toBe(1);
      expect(await t.prisma.auditLog.count({ where: { action: 'enrollment.activate', programId: p.id } })).toBe(1);
      const again = await c.post(`${ADMIN}/${e.id}/activate`).send({ paymentReference: 'UTR-1002', paymentAmountMinor: '120000' }).expect(409);
      expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('keeps payment references unique (also against recorded sale ids)', async () => {
      const first = await pendingPaid();
      await sa.post(`${ADMIN}/${first.e.id}/activate`).send({ paymentReference: 'UTR-DUP', paymentAmountMinor: '120000' }).expect(200);
      const second = await pendingPaid();
      const dup = await sa.post(`${ADMIN}/${second.e.id}/activate`).send({ paymentReference: 'UTR-DUP', paymentAmountMinor: '120000' }).expect(409);
      expect(dup.body.error.details.issues[0].path).toBe('paymentReference');
      const subject = await createUser(t.prisma);
      await createEvent(t.prisma, { programId: second.p.id, subjectUserId: subject.id, externalId: 'SALE-42' });
      await sa.post(`${ADMIN}/${second.e.id}/activate`).send({ paymentReference: 'SALE-42', paymentAmountMinor: '120000' }).expect(409);
    });

    it('activates a paid renewal from the end of the current period', async () => {
      const p = await program();
      const m = await member();
      const current = await createEnrollment(t.prisma, { userId: m.user.id, programId: p.id, optionId: p.options[1]!.id });
      const renewal = (await m.c.post(enrollUrl(p.id)).send({ optionId: p.options[1]!.id, acceptTerms: true }).expect(201)).body.data;
      expect(renewal.status).toBe('PENDING');
      const res = await sa.post(`${ADMIN}/${renewal.id}/activate`).send({ paymentReference: `UTR-${randomUUID()}`, paymentAmountMinor: '120000' }).expect(200);
      expect(res.body.data.effectiveFrom).toBe(current.effectiveTo!.toISOString());
      expect(res.body.data.upcoming).toBe(true);
    });

    it('rejects pending enrollments with a reason', async () => {
      const { e } = await pendingPaid();
      await sa.post(`${ADMIN}/${e.id}/reject`).send({}).expect(400);
      const res = await sa.post(`${ADMIN}/${e.id}/reject`).send({ reason: REASON }).expect(200);
      expect(res.body.data).toMatchObject({ status: 'REJECTED', eligibilityStatus: 'INELIGIBLE', statusReason: REASON, allowedActions: [] });
      await sa.post(`${ADMIN}/${e.id}/reject`).send({ reason: REASON }).expect(409);
    });

    it('lists the queue scoped to the admin’s programs, with filters', async () => {
      const a = await pendingPaid();
      const b = await pendingPaid();
      const owner = await createUser(t.prisma, { roles: ['PROGRAM_ADMIN'], programScopes: [a.p.id] });
      const c = await loginAs(t, owner);
      const list = await c.get(`${ADMIN}?status=PENDING`).expect(200);
      expect(list.body.data.map((e: { id: string }) => e.id)).toEqual([a.e.id]);
      const all = await sa.get(`${ADMIN}?status=PENDING`).expect(200);
      expect(all.body.data).toHaveLength(2);
      const byName = await sa.get(`${ADMIN}?q=${encodeURIComponent(b.m.user.fullName)}`).expect(200);
      expect(byName.body.data.map((e: { id: string }) => e.id)).toEqual([b.e.id]);
      const finance = await createUser(t.prisma, { roles: ['FINANCE_REVIEWER'] });
      await (await loginAs(t, finance)).get(ADMIN).expect(403);
      await a.m.c.get(ADMIN).expect(403);
    });
  });

  describe('cancellation', () => {
    it('member cancels a pending enrollment; others cannot touch it', async () => {
      const p = await program();
      const m = await member();
      const e = (await m.c.post(enrollUrl(p.id)).send({ optionId: p.options[1]!.id, acceptTerms: true }).expect(201)).body.data;
      const other = await member();
      await other.c.post(`${MINE}/${e.id}/cancel`).expect(404);
      const res = await m.c.post(`${MINE}/${e.id}/cancel`).expect(200);
      expect(res.body.data).toMatchObject({ status: 'CANCELLED', eligibilityStatus: 'INELIGIBLE', canCancel: false });
      expect(res.body.data.cancelledAt).toEqual(expect.any(String));
      expect((await m.c.post(`${MINE}/${e.id}/cancel`).send({}).expect(409)).body.error.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('shortens running coverage to now and turns a queued renewal into an empty period', async () => {
      const p = await program();
      const m = await member();
      const current = (await m.c.post(enrollUrl(p.id)).send({ optionId: p.options[0]!.id, acceptTerms: true }).expect(201)).body.data;
      const renewal = (await m.c.post(enrollUrl(p.id)).send({ optionId: p.options[0]!.id, acceptTerms: true }).expect(201)).body.data;

      const r = (await m.c.post(`${MINE}/${renewal.id}/cancel`).send({ reason: 'Changed my mind' }).expect(200)).body.data;
      expect(r).toMatchObject({ status: 'CANCELLED', effectiveFrom: renewal.effectiveFrom, effectiveTo: renewal.effectiveFrom, statusReason: 'Changed my mind' });

      const c = (await m.c.post(`${MINE}/${current.id}/cancel`).expect(200)).body.data;
      expect(c.status).toBe('CANCELLED');
      expect(c.eligibilityStatus).toBe('ELIGIBLE');
      expect(Math.abs(Date.parse(c.effectiveTo) - Date.now())).toBeLessThan(60_000);
      expect(Date.parse(c.effectiveTo)).toBeLessThan(Date.parse(current.effectiveTo));
    });

    it('refuses to cancel coverage that already ended', async () => {
      const p = await program();
      const m = await member();
      const ended = await backdated(m.user.id, p.id, p.options[0]!.id, new Date(Date.now() - 31 * DAY), new Date(Date.now() - DAY));
      const res = await m.c.post(`${MINE}/${ended.id}/cancel`).expect(409);
      expect(res.body.error.message).toMatch(/already ended/);
    });

    it('admin cancellation needs a reason and notifies the member', async () => {
      const p = await program();
      const m = await member();
      const e = (await m.c.post(enrollUrl(p.id)).send({ optionId: p.options[0]!.id, acceptTerms: true }).expect(201)).body.data;
      await sa.post(`${ADMIN}/${e.id}/cancel`).send({ reason: 'short' }).expect(400);
      const res = await sa.post(`${ADMIN}/${e.id}/cancel`).send({ reason: 'Member requested closure by phone' }).expect(200);
      expect(res.body.data.status).toBe('CANCELLED');
      const notice = await t.prisma.outboxMessage.findFirst({ where: { topic: 'notification.create', payload: { path: ['type'], equals: 'enrollment.cancelled' } } });
      expect(notice?.payload).toMatchObject({ userId: m.user.id });
    });
  });

  describe('expiry job', () => {
    it('expires ended ACTIVE coverage idempotently, as system, keeping eligibility for past sales', async () => {
      const p = await program();
      const m = await member();
      const ended = await backdated(m.user.id, p.id, p.options[0]!.id, new Date(Date.now() - 31 * DAY), new Date(Date.now() - 1000));
      const running = await createEnrollment(t.prisma, { userId: (await createUser(t.prisma)).id, programId: p.id });

      const registry = t.get(ScheduledJobsRegistry);
      await registry.runNow(ENROLLMENT_EXPIRY_JOB);
      const after = await t.prisma.programEnrollment.findUniqueOrThrow({ where: { id: ended.id } });
      expect(after).toMatchObject({ status: 'EXPIRED', eligibilityStatus: 'ELIGIBLE' });
      expect((await t.prisma.programEnrollment.findUniqueOrThrow({ where: { id: running.id } })).status).toBe('ACTIVE');
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'enrollment.expire', resourceId: ended.id } });
      expect(audit).toMatchObject({ actorUserId: null, actorRoles: ['SYSTEM'], programId: p.id });

      await registry.runNow(ENROLLMENT_EXPIRY_JOB);
      expect(await t.prisma.auditLog.count({ where: { action: 'enrollment.expire' } })).toBe(1);
      expect((await m.c.get(MINE).expect(200)).body.data[0]).toMatchObject({ status: 'EXPIRED', canCancel: false });
    });
  });
});
