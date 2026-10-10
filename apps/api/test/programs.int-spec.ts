import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ScheduledJobsRegistry } from '../src/jobs/scheduler/scheduled-jobs.registry';
import { ProgramLifecycleService } from '../src/modules/programs/program-lifecycle.service';
import { PROGRAM_STATUS_JOB } from '../src/modules/programs/programs.jobs';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import {
  createEnrollment,
  createOffering,
  createPolicy,
  createProgram,
  createUser,
  factoryAdmin,
  loginAs,
  type LoggedInClient,
  type TestUser,
} from './utils/factories';

const BASE = '/api/v1/admin/programs';
const DAY = 86_400_000;
const REASON = 'Pausing while the supplier restocks';
const CANCEL_REASON = 'Launch postponed by the supplier';

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

describe('admin programs (business rules §1, §4)', () => {
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

  async function draft(overrides: Record<string, unknown> = {}) {
    const offering = await createOffering(t.prisma, { status: 'ACTIVE' });
    const res = await sa
      .post(BASE)
      .send({
        code: `prog-${Math.random().toString(36).slice(2, 8)}`,
        name: 'Clean Water',
        offeringId: offering.id,
        startsAt: iso(-1),
        endsAt: iso(90),
        termsText: 'Plan terms v1',
        ...overrides,
      })
      .expect(201);
    return res.body.data;
  }

  async function addOption(programId: string, body: Record<string, unknown> = {}) {
    const res = await sa
      .post(`${BASE}/${programId}/options`)
      .send({ name: 'Monthly', priceMinor: '49900', billingFrequency: 'MONTHLY', durationDays: 30, ...body })
      .expect(201);
    return res.body.data;
  }

  async function publishable(overrides: Record<string, unknown> = {}) {
    const p = await draft(overrides);
    await addOption(p.id);
    await createPolicy(t.prisma, { programId: p.id });
    return p;
  }

  async function detail(id: string, c: LoggedInClient = sa) {
    return (await c.get(`${BASE}/${id}`).expect(200)).body.data;
  }

  describe('create', () => {
    it('creates a DRAFT that snapshots the platform unit and currency', async () => {
      await t.prisma.platformSettings.update({
        where: { id: 1 },
        data: { rewardUnit: 'POINTS', currencyCode: 'USD', currencyMinorUnits: 2 },
      });
      const p = await draft({ maxRewardDepth: 3, eligibility: { requireSponsor: true } });
      expect(p).toMatchObject({
        status: 'DRAFT',
        rewardUnit: 'POINTS',
        currencyCode: 'USD',
        currencyMinorUnits: 2,
        maxRewardDepth: 3,
        timezone: 'Asia/Kolkata',
        eligibility: { requireSponsor: true },
        termsVersion: '1.0',
        version: 1,
        editableFields: expect.arrayContaining(['code', 'offeringId']),
        allowedActions: ['publish'],
        canDelete: true,
        createdBy: { id: superAdmin.id },
      });
      expect(p.statusHistory).toEqual([expect.objectContaining({ fromStatus: null, toStatus: 'DRAFT', changedBy: { id: superAdmin.id, fullName: expect.any(String) } })]);
      expect(p.publishChecks.find((c: { key: string }) => c.key === 'ACTIVE_OPTION').ok).toBe(false);
      expect(await t.prisma.auditLog.count({ where: { action: 'program.create', programId: p.id } })).toBe(1);
    });

    it('validates dates, code format and uniqueness', async () => {
      const offering = await createOffering(t.prisma, { status: 'ACTIVE' });
      const base = { name: 'X program', offeringId: offering.id, startsAt: iso(1) };
      const bad = await sa.post(BASE).send({ ...base, code: 'dates-bad', endsAt: iso(0) }).expect(400);
      expect(bad.body.error.details.issues.map((i: { path: string }) => i.path)).toContain('endsAt');
      await sa.post(BASE).send({ ...base, code: 'Not A Slug', endsAt: iso(10) }).expect(400);
      await sa.post(BASE).send({ ...base, code: 'dup-code', endsAt: iso(10) }).expect(201);
      const dup = await sa.post(BASE).send({ ...base, code: 'dup-code', endsAt: iso(10) }).expect(409);
      expect(dup.body.error.details.issues[0].path).toBe('code');
      const missing = await sa.post(BASE).send({ ...base, code: 'no-offering', offeringId: '00000000-0000-4000-8000-000000000000' }).expect(400);
      expect(missing.body.error.details.issues[0].path).toBe('offeringId');
    });

    it('a program admin who creates a program is assigned to it', async () => {
      const offering = await createOffering(t.prisma, { status: 'ACTIVE' });
      const pa = await createUser(t.prisma, { roles: ['PROGRAM_ADMIN'] });
      const c = await loginAs(t, pa);
      const res = await c.post(BASE).send({ code: 'pa-owned', name: 'PA owned', offeringId: offering.id, startsAt: iso(1) }).expect(201);
      expect(await t.prisma.programAdminAssignment.count({ where: { userId: pa.id, programId: res.body.data.id } })).toBe(1);
      await c.get(`${BASE}/${res.body.data.id}`).expect(200);
    });
  });

  describe('scoping', () => {
    it('program admins only see and change their assigned programs; finance reviewers read all', async () => {
      const mine = await createProgram(t.prisma, { status: 'ACTIVE', name: 'Mine' });
      const other = await createProgram(t.prisma, { status: 'ACTIVE', name: 'Other' });
      const pa = await createUser(t.prisma, { roles: ['PROGRAM_ADMIN'], programScopes: [mine.id] });
      const c = await loginAs(t, pa);

      const list = await c.get(BASE).expect(200);
      expect(list.body.data.map((p: { id: string }) => p.id)).toEqual([mine.id]);
      await c.get(`${BASE}/${mine.id}`).expect(200);
      expect((await c.get(`${BASE}/${other.id}`).expect(403)).body.error.code).toBe('FORBIDDEN');
      await c.patch(`${BASE}/${other.id}`).send({ expectedVersion: other.version, name: 'Hijacked' }).expect(403);
      await c.post(`${BASE}/${other.id}/pause`).send({ reason: REASON }).expect(403);
      await c.post(`${BASE}/${other.id}/options`).send({ name: 'X', priceMinor: '0', billingFrequency: 'ONE_TIME', durationDays: 10 }).expect(403);
      await c.get(`${BASE}/${other.id}/admins`).expect(403);

      const finance = await createUser(t.prisma, { roles: ['FINANCE_REVIEWER'] });
      const f = await loginAs(t, finance);
      expect((await f.get(BASE).expect(200)).body.data).toHaveLength(2);
      await f.get(`${BASE}/${other.id}`).expect(200);
      await f.patch(`${BASE}/${other.id}`).send({ expectedVersion: other.version, name: 'Nope' }).expect(403);

      const member = await createUser(t.prisma);
      await (await loginAs(t, member)).get(BASE).expect(403);
    });

    it('filters by status (one or several) and searches name/code', async () => {
      await createProgram(t.prisma, { status: 'ACTIVE', name: 'Alpha', code: 'alpha-one' });
      await createProgram(t.prisma, { status: 'PAUSED', name: 'Beta' });
      await createProgram(t.prisma, { status: 'DRAFT', name: 'Gamma' });
      const one = await sa.get(`${BASE}?status=PAUSED`).expect(200);
      expect(one.body.data.map((p: { name: string }) => p.name)).toEqual(['Beta']);
      const many = await sa.get(`${BASE}?status=ACTIVE&status=DRAFT`).expect(200);
      expect(many.body.data.map((p: { name: string }) => p.name).sort()).toEqual(['Alpha', 'Gamma']);
      const q = await sa.get(`${BASE}?q=ALPHA-ONE`).expect(200);
      expect(q.body.data).toHaveLength(1);
      await sa.get(`${BASE}?status=BOGUS`).expect(400);
    });
  });

  describe('edit', () => {
    it('uses optimistic concurrency', async () => {
      const p = await draft();
      const ok = await sa.patch(`${BASE}/${p.id}`).send({ expectedVersion: p.version, name: 'Renamed' }).expect(200);
      expect(ok.body.data).toMatchObject({ name: 'Renamed', version: p.version + 1 });
      const stale = await sa.patch(`${BASE}/${p.id}`).send({ expectedVersion: p.version, name: 'Again' }).expect(409);
      expect(stale.body.error.code).toBe('STALE_VERSION');
      const noop = await sa.patch(`${BASE}/${p.id}`).send({ expectedVersion: ok.body.data.version, name: 'Renamed' }).expect(200);
      expect(noop.body.data.version).toBe(ok.body.data.version);
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'program.update', programId: p.id } });
      expect(audit.before).toEqual({ name: 'Clean Water' });
      expect(audit.after).toEqual({ name: 'Renamed' });
    });

    it('limits edits after publication (frozen fields, future end, new terms version)', async () => {
      const p = await createProgram(t.prisma, { status: 'ACTIVE' });
      const frozen = await sa.patch(`${BASE}/${p.id}`).send({ expectedVersion: p.version, code: 'new-code', maxRewardDepth: 2 }).expect(409);
      expect(frozen.body.error.code).toBe('INVALID_STATE_TRANSITION');
      expect(frozen.body.error.details.fields).toEqual(['code', 'maxRewardDepth']);
      const past = await sa.patch(`${BASE}/${p.id}`).send({ expectedVersion: p.version, endsAt: iso(-1) }).expect(400);
      expect(past.body.error.details.issues[0].path).toBe('endsAt');
      const terms = await sa.patch(`${BASE}/${p.id}`).send({ expectedVersion: p.version, termsText: 'New terms' }).expect(400);
      expect(terms.body.error.details.issues[0].path).toBe('termsVersion');
      const ok = await sa
        .patch(`${BASE}/${p.id}`)
        .send({ expectedVersion: p.version, termsText: 'New terms', termsVersion: '2.0', endsAt: iso(200), name: 'Renamed live' })
        .expect(200);
      expect(ok.body.data).toMatchObject({ termsVersion: '2.0', termsText: 'New terms', name: 'Renamed live' });
      // The DB guard backs the frozen-field rule.
      await expect(t.prisma.program.update({ where: { id: p.id }, data: { code: 'sneaky' } })).rejects.toThrow();
    });
  });

  describe('lifecycle', () => {
    it('refuses to publish until every precondition holds', async () => {
      const inactive = await createOffering(t.prisma, { status: 'INACTIVE' });
      const p = await draft({ offeringId: inactive.id });
      const res = await sa.post(`${BASE}/${p.id}/publish`).expect(409);
      expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
      expect(res.body.error.details.checks.map((c: { key: string }) => c.key).sort()).toEqual(['ACTIVE_OPTION', 'OFFERING_ACTIVE', 'PUBLISHED_POLICY']);
      await addOption(p.id);
      await createPolicy(t.prisma, { programId: p.id });
      expect((await sa.post(`${BASE}/${p.id}/publish`).send({}).expect(409)).body.error.details.checks).toEqual([
        expect.objectContaining({ key: 'OFFERING_ACTIVE' }),
      ]);
      await t.prisma.offering.update({ where: { id: inactive.id }, data: { status: 'ACTIVE', approvedById: superAdmin.id, approvedAt: new Date() } });
      const published = await sa.post(`${BASE}/${p.id}/publish`).send({ reason: 'Launch approved by the board' }).expect(200);
      expect(published.body.data).toMatchObject({ status: 'ACTIVE', allowedActions: ['pause', 'complete'], canDelete: false });
      expect(published.body.data.publishedAt).toEqual(expect.any(String));
      expect(published.body.data.statusHistory[0]).toMatchObject({
        fromStatus: 'DRAFT',
        toStatus: 'ACTIVE',
        reason: 'Launch approved by the board',
        changedBy: { id: superAdmin.id },
      });
    });

    it('publishes a future program as SCHEDULED', async () => {
      const p = await publishable({ startsAt: iso(5), endsAt: iso(60) });
      const res = await sa.post(`${BASE}/${p.id}/publish`).expect(200);
      expect(res.body.data.status).toBe('SCHEDULED');
      expect(res.body.data.allowedActions).toEqual(['cancel']);
    });

    it('cancels a SCHEDULED program before it starts: ARCHIVED, end date kept, reason and audit', async () => {
      const p = await publishable({ startsAt: iso(5), endsAt: iso(60) });
      const scheduled = (await sa.post(`${BASE}/${p.id}/publish`).expect(200)).body.data;
      await sa.post(`${BASE}/${p.id}/cancel`).send({}).expect(400);
      await sa.post(`${BASE}/${p.id}/cancel`).send({ reason: 'short' }).expect(400);
      await sa.post(`${BASE}/${p.id}/cancel`).send({ reason: CANCEL_REASON, expectedVersion: scheduled.version - 1 }).expect(409);

      const res = await sa.post(`${BASE}/${p.id}/cancel`).send({ reason: CANCEL_REASON, expectedVersion: scheduled.version }).expect(200);
      expect(res.body.data).toMatchObject({
        status: 'ARCHIVED',
        endsAt: scheduled.endsAt,
        startsAt: scheduled.startsAt,
        allowedActions: [],
        editableFields: [],
        canDelete: false,
      });
      expect(res.body.data.statusHistory[0]).toMatchObject({
        fromStatus: 'SCHEDULED',
        toStatus: 'ARCHIVED',
        reason: CANCEL_REASON,
        changedBy: { id: superAdmin.id },
      });
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'program.cancel', programId: p.id } });
      expect(audit).toMatchObject({ resourceType: 'program', resourceId: p.id, reason: CANCEL_REASON, actorUserId: superAdmin.id });
      expect(audit.before).toEqual({ status: 'SCHEDULED' });
      expect(audit.after).toEqual({ status: 'ARCHIVED' });

      // Terminal: no second cancel, no edits, and the scheduler never starts it.
      expect((await sa.post(`${BASE}/${p.id}/cancel`).send({ reason: CANCEL_REASON }).expect(409)).body.error.code).toBe(
        'INVALID_STATE_TRANSITION',
      );
      await sa.patch(`${BASE}/${p.id}`).send({ expectedVersion: res.body.data.version, name: 'Nope' }).expect(409);
      await t.get(ProgramLifecycleService).applyScheduledTransitions(new Date(Date.now() + 10 * DAY));
      expect((await t.prisma.program.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('ARCHIVED');
    });

    it('gives an open-ended cancelled program the earliest end the date CHECKs allow', async () => {
      const startsAt = new Date(Date.now() + 5 * DAY);
      const plain = await createProgram(t.prisma, { status: 'SCHEDULED', startsAt, endsAt: null });
      const v1 = (await sa.post(`${BASE}/${plain.id}/cancel`).send({ reason: CANCEL_REASON }).expect(200)).body.data;
      expect(v1).toMatchObject({ status: 'ARCHIVED', endsAt: new Date(startsAt.getTime() + 1_000).toISOString() });

      const closesAt = new Date(Date.now() + 20 * DAY);
      const windowed = await createProgram(t.prisma, { status: 'SCHEDULED', startsAt, endsAt: null, enrollmentClosesAt: closesAt });
      const v2 = (await sa.post(`${BASE}/${windowed.id}/cancel`).send({ reason: CANCEL_REASON }).expect(200)).body.data;
      expect(v2).toMatchObject({ status: 'ARCHIVED', endsAt: closesAt.toISOString(), enrollmentClosesAt: closesAt.toISOString() });
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'program.cancel', programId: windowed.id } });
      expect(audit.before).toEqual({ status: 'SCHEDULED', endsAt: null });
      expect(audit.after).toEqual({ status: 'ARCHIVED', endsAt: closesAt.toISOString() });
    });

    it('refuses to cancel a program that is not scheduled or whose start has passed', async () => {
      const active = await createProgram(t.prisma, { status: 'ACTIVE' });
      expect((await sa.post(`${BASE}/${active.id}/cancel`).send({ reason: CANCEL_REASON }).expect(409)).body.error.code).toBe(
        'INVALID_STATE_TRANSITION',
      );
      const draftProgram = await createProgram(t.prisma, { status: 'DRAFT' });
      await sa.post(`${BASE}/${draftProgram.id}/cancel`).send({ reason: CANCEL_REASON }).expect(409);
      // Start reached but the scheduler has not activated it yet: it is starting, not cancellable.
      const starting = await createProgram(t.prisma, { status: 'SCHEDULED', startsAt: new Date(Date.now() - 60_000) });
      const res = await sa.post(`${BASE}/${starting.id}/cancel`).send({ reason: CANCEL_REASON }).expect(409);
      expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
      expect((await t.prisma.program.findUniqueOrThrow({ where: { id: starting.id } })).status).toBe('SCHEDULED');
      await sa.post(`${BASE}/${randomUUID()}/cancel`).send({ reason: CANCEL_REASON }).expect(404);
    });

    it('requires programs:publish and program scope to cancel', async () => {
      const startsAt = new Date(Date.now() + 5 * DAY);
      const mine = await createProgram(t.prisma, { status: 'SCHEDULED', startsAt });
      const other = await createProgram(t.prisma, { status: 'SCHEDULED', startsAt });
      const pa = await loginAs(t, await createUser(t.prisma, { roles: ['PROGRAM_ADMIN'], programScopes: [mine.id] }));
      await pa.post(`${BASE}/${other.id}/cancel`).send({ reason: CANCEL_REASON }).expect(403);
      const finance = await loginAs(t, await createUser(t.prisma, { roles: ['FINANCE_REVIEWER'] }));
      await finance.post(`${BASE}/${mine.id}/cancel`).send({ reason: CANCEL_REASON }).expect(403);
      const member = await loginAs(t, await createUser(t.prisma));
      await member.post(`${BASE}/${mine.id}/cancel`).send({ reason: CANCEL_REASON }).expect(403);
      expect((await pa.post(`${BASE}/${mine.id}/cancel`).send({ reason: CANCEL_REASON }).expect(200)).body.data.status).toBe('ARCHIVED');
      expect((await t.prisma.program.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('SCHEDULED');
    });

    it('the DB state machine allows SCHEDULED to ARCHIVED (with an end) and no other shortcut', async () => {
      const startsAt = new Date(Date.now() + 5 * DAY);
      const endsAt = new Date(startsAt.getTime() + DAY);
      const a = await createProgram(t.prisma, { status: 'SCHEDULED', startsAt, endsAt: null });
      // ARCHIVED needs an end date (CHECK); COMPLETED / PAUSED are not reachable from SCHEDULED.
      await expect(t.prisma.program.update({ where: { id: a.id }, data: { status: 'ARCHIVED' } })).rejects.toThrow();
      await expect(t.prisma.program.update({ where: { id: a.id }, data: { status: 'COMPLETED', endsAt } })).rejects.toThrow();
      await expect(t.prisma.program.update({ where: { id: a.id }, data: { status: 'PAUSED' } })).rejects.toThrow();
      const archived = await t.prisma.program.update({ where: { id: a.id }, data: { status: 'ARCHIVED', endsAt } });
      expect(archived.status).toBe('ARCHIVED');
      await expect(t.prisma.program.update({ where: { id: a.id }, data: { status: 'SCHEDULED' } })).rejects.toThrow();
    });

    it('walks ACTIVE → PAUSED → ACTIVE → COMPLETED → ARCHIVED with reasons and audit', async () => {
      const p = await publishable();
      let v = (await sa.post(`${BASE}/${p.id}/publish`).expect(200)).body.data;
      await sa.post(`${BASE}/${p.id}/pause`).send({}).expect(400);
      v = (await sa.post(`${BASE}/${p.id}/pause`).send({ reason: REASON, expectedVersion: v.version }).expect(200)).body.data;
      expect(v.status).toBe('PAUSED');
      expect((await sa.post(`${BASE}/${p.id}/pause`).send({ reason: REASON }).expect(409)).body.error.code).toBe('INVALID_STATE_TRANSITION');
      await sa.post(`${BASE}/${p.id}/resume`).send({ expectedVersion: v.version - 1 }).expect(409);
      v = (await sa.post(`${BASE}/${p.id}/resume`).expect(200)).body.data;
      expect(v.status).toBe('ACTIVE');
      v = (await sa.post(`${BASE}/${p.id}/complete`).send({ reason: 'Season finished early' }).expect(200)).body.data;
      expect(v.status).toBe('COMPLETED');
      expect(Math.abs(Date.parse(v.endsAt) - Date.now())).toBeLessThan(60_000);
      expect(v.editableFields).not.toContain('endsAt');
      v = (await sa.post(`${BASE}/${p.id}/archive`).expect(200)).body.data;
      expect(v.status).toBe('ARCHIVED');
      expect(v.editableFields).toEqual([]);
      await sa.patch(`${BASE}/${p.id}`).send({ expectedVersion: v.version, name: 'Nope' }).expect(409);

      const changes = await t.prisma.programStatusChange.findMany({ where: { programId: p.id }, orderBy: { changedAt: 'asc' } });
      expect(changes.map((c) => c.toStatus)).toEqual(['DRAFT', 'ACTIVE', 'PAUSED', 'ACTIVE', 'COMPLETED', 'ARCHIVED']);
      expect(changes.find((c) => c.toStatus === 'PAUSED')?.reason).toBe(REASON);
      const actions = (await t.prisma.auditLog.findMany({ where: { programId: p.id, action: { startsWith: 'program.' } } })).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(['program.publish', 'program.pause', 'program.resume', 'program.complete', 'program.archive']));
      // The DB state machine refuses going back, whatever the caller.
      await expect(t.prisma.program.update({ where: { id: p.id }, data: { status: 'DRAFT' } })).rejects.toThrow();
    });

    it('completing pulls a later enrollment close date in to the new end', async () => {
      const p = await createProgram(t.prisma, { status: 'ACTIVE', enrollmentClosesAt: new Date(Date.now() + 30 * DAY) });
      const res = await sa.post(`${BASE}/${p.id}/complete`).expect(200);
      expect(res.body.data.enrollmentClosesAt).toBe(res.body.data.endsAt);
    });

    it('deletes drafts only (not with published policies)', async () => {
      const active = await createProgram(t.prisma, { status: 'ACTIVE' });
      expect((await sa.delete(`${BASE}/${active.id}`).expect(409)).body.error.code).toBe('INVALID_STATE_TRANSITION');
      const withPolicy = await publishable();
      await sa.delete(`${BASE}/${withPolicy.id}`).expect(409);
      const plain = await draft();
      await addOption(plain.id);
      await sa.delete(`${BASE}/${plain.id}`).expect(204);
      await sa.get(`${BASE}/${plain.id}`).expect(404);
      expect(await t.prisma.auditLog.count({ where: { action: 'program.delete', programId: plain.id } })).toBe(1);
    });
  });

  describe('options', () => {
    it('creates options in the program currency and validates duration vs frequency', async () => {
      const p = await draft();
      const bad = await sa.post(`${BASE}/${p.id}/options`).send({ name: 'Q', priceMinor: '1000', billingFrequency: 'QUARTERLY', durationDays: 30 }).expect(400);
      expect(bad.body.error.details.issues[0].path).toEqual(expect.stringContaining('durationDays'));
      await sa.post(`${BASE}/${p.id}/options`).send({ name: 'Bad price', priceMinor: '12.50', billingFrequency: 'ONE_TIME', durationDays: 30 }).expect(400);
      const o = await addOption(p.id, { name: 'Yearly', priceMinor: '499900', billingFrequency: 'YEARLY', durationDays: 365 });
      expect(o).toMatchObject({ priceMinor: '499900', currencyCode: 'INR', isActive: true, termsLocked: false, enrollmentCount: 0, sortOrder: 0 });
      const second = await addOption(p.id, { name: 'Free trial', priceMinor: '0', billingFrequency: 'ONE_TIME', durationDays: 14 });
      expect(second.sortOrder).toBe(1);
      const merged = await sa.patch(`${BASE}/${p.id}/options/${o.id}`).send({ billingFrequency: 'MONTHLY' }).expect(400);
      expect(merged.body.error.details.issues[0].path).toBe('durationDays');
    });

    it('freezes price, duration and frequency once an option has enrollments', async () => {
      const p = await createProgram(t.prisma, { status: 'ACTIVE', options: [{ name: 'Paid', priceMinor: 10_000n, durationDays: 365 }] });
      const option = p.options[0]!;
      const member = await createUser(t.prisma);
      await createEnrollment(t.prisma, { userId: member.id, programId: p.id, status: 'PENDING' });
      const res = await sa.patch(`${BASE}/${p.id}/options/${option.id}`).send({ priceMinor: '20000' }).expect(409);
      expect(res.body.error.message).toMatch(/Create a new option/);
      const wording = await sa.patch(`${BASE}/${p.id}/options/${option.id}`).send({ name: 'Paid plan', description: 'Annual access' }).expect(200);
      expect(wording.body.data).toMatchObject({ name: 'Paid plan', description: 'Annual access', termsLocked: true, enrollmentCount: 1 });
    });

    it('keeps at least one active option on a live program', async () => {
      const p = await createProgram(t.prisma, { status: 'ACTIVE' });
      const only = p.options[0]!;
      await sa.post(`${BASE}/${p.id}/options/${only.id}/deactivate`).expect(409);
      const extra = await addOption(p.id);
      const off = await sa.post(`${BASE}/${p.id}/options/${only.id}/deactivate`).expect(200);
      expect(off.body.data.isActive).toBe(false);
      await sa.post(`${BASE}/${p.id}/options/${extra.id}/deactivate`).expect(409);
      await sa.post(`${BASE}/${p.id}/options/${only.id}/activate`).expect(200);
      expect(await t.prisma.auditLog.count({ where: { programId: p.id, action: 'program_option.deactivate' } })).toBe(1);
      const unknown = '00000000-0000-4000-8000-000000000000';
      await sa.patch(`${BASE}/${p.id}/options/${unknown}`).send({ name: 'x' }).expect(404);
    });
  });

  describe('admin assignments', () => {
    it('assigns program admins (roles:assign); scope applies on the next request', async () => {
      const p = await createProgram(t.prisma, { status: 'ACTIVE' });
      const pa = await createUser(t.prisma, { roles: ['PROGRAM_ADMIN'] });
      const notAdmin = await createUser(t.prisma);
      const c = await loginAs(t, pa);
      await c.get(`${BASE}/${p.id}`).expect(403);

      const candidates = await sa.get(`${BASE}/${p.id}/admins/candidates`).expect(200);
      expect(candidates.body.data.map((u: { userId: string }) => u.userId)).toContain(pa.id);
      const invalid = await sa.put(`${BASE}/${p.id}/admins`).send({ userIds: [pa.id, notAdmin.id] }).expect(400);
      expect(invalid.body.error.details.issues[0].path).toBe('userIds.1');
      const res = await sa.put(`${BASE}/${p.id}/admins`).send({ userIds: [pa.id], reason: 'Owns the water purifier line' }).expect(200);
      expect(res.body.data).toEqual([expect.objectContaining({ userId: pa.id, email: pa.email })]);
      await c.get(`${BASE}/${p.id}`).expect(200);
      // Program admins see the list with masked emails and cannot change it.
      const seen = await c.get(`${BASE}/${p.id}/admins`).expect(200);
      expect(seen.body.data[0].email).not.toBe(pa.email);
      await c.put(`${BASE}/${p.id}/admins`).send({ userIds: [] }).expect(403);

      await sa.put(`${BASE}/${p.id}/admins`).send({ userIds: [] }).expect(200);
      await c.get(`${BASE}/${p.id}`).expect(403);
      expect(await t.prisma.auditLog.count({ where: { action: 'program.admins_set', programId: p.id } })).toBe(2);
    });
  });

  describe('scheduler', () => {
    it('starts due SCHEDULED programs and completes ended ones, idempotently and as system', async () => {
      const due = await createProgram(t.prisma, { status: 'SCHEDULED', startsAt: new Date(Date.now() - 60_000) });
      const future = await createProgram(t.prisma, { status: 'SCHEDULED', startsAt: new Date(Date.now() + DAY) });
      const ended = await createProgram(t.prisma, { status: 'PAUSED', startsAt: new Date(Date.now() - 30 * DAY), endsAt: new Date(Date.now() - DAY) });
      const running = await createProgram(t.prisma, { status: 'ACTIVE' });

      const registry = t.get(ScheduledJobsRegistry);
      await registry.runNow(PROGRAM_STATUS_JOB);
      const statuses = Object.fromEntries(
        (await t.prisma.program.findMany({ select: { id: true, status: true } })).map((p) => [p.id, p.status]),
      );
      expect(statuses[due.id]).toBe('ACTIVE');
      expect(statuses[future.id]).toBe('SCHEDULED');
      expect(statuses[ended.id]).toBe('COMPLETED');
      expect(statuses[running.id]).toBe('ACTIVE');

      const start = await t.prisma.programStatusChange.findFirstOrThrow({ where: { programId: due.id, toStatus: 'ACTIVE' } });
      expect(start).toMatchObject({ fromStatus: 'SCHEDULED', changedById: null, reason: 'Start date reached' });
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'program.auto_complete', programId: ended.id } });
      expect(audit).toMatchObject({ actorUserId: null, actorRoles: ['SYSTEM'] });

      const before = await t.prisma.programStatusChange.count();
      await registry.runNow(PROGRAM_STATUS_JOB);
      expect(await t.prisma.programStatusChange.count()).toBe(before);
    });
  });
});
