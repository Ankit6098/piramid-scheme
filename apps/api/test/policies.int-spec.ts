import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DryRunResultDto, PolicyVersionDto, PolicyVersionSummaryDto, RecordSaleResultDto } from '@app/shared';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import {
  createEnrollment,
  createPolicy,
  createProgram,
  createUser,
  factoryAdmin,
  loginAs,
  type LoggedInClient,
  type TestUser,
} from './utils/factories';

const HOUR = 3_600_000;

describe('reward policies (business rules §7)', () => {
  let t: TestApp;
  let superAdmin: TestUser;
  let su: LoggedInClient;

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

  const rules = [
    { level: 1, calcType: 'PERCENTAGE', percentageBps: 1000 },
    { level: 2, calcType: 'PERCENTAGE', percentageBps: 500 },
  ];

  async function draft(client: LoggedInClient, programId: string, body: Record<string, unknown> = {}): Promise<PolicyVersionDto> {
    const res = await client.post(`/api/v1/admin/programs/${programId}/policies`).send({ rules, ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data as PolicyVersionDto;
  }

  async function publish(client: LoggedInClient, id: string, effectiveFrom: Date = new Date()) {
    return client.post(`/api/v1/admin/policies/${id}/publish`).send({ effectiveFrom: effectiveFrom.toISOString() });
  }

  async function versions(programId: string): Promise<PolicyVersionSummaryDto[]> {
    const res = await su.get(`/api/v1/admin/programs/${programId}/policies`);
    expect(res.status).toBe(200);
    return res.body.data as PolicyVersionSummaryDto[];
  }

  describe('drafts', () => {
    it('creates a draft with platform defaults and lists it', async () => {
      await t.prisma.platformSettings.update({ where: { id: 1 }, data: { defaultRewardBudgetBps: 1500, pointsPerCurrencyUnit: 3 } });
      const program = await createProgram(t.prisma, { maxRewardDepth: 4 });
      const res = await su.post(`/api/v1/admin/programs/${program.id}/policies`).send({});
      expect(res.status).toBe(201);
      const d = res.body.data as PolicyVersionDto;
      expect(d).toMatchObject({
        version: 1,
        status: 'DRAFT',
        phase: 'DRAFT',
        name: 'Policy v1',
        budgetBps: 1500,
        pointsPerCurrencyUnit: 3,
        maxDepth: 3,
        effectiveFrom: null,
        rules: [],
        requiresApproval: true,
        program: { id: program.id, maxRewardDepth: 4, currencyCode: 'INR' },
      });
      expect(await versions(program.id)).toHaveLength(1);
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'policy.create', resourceId: d.id } });
      expect(audit.programId).toBe(program.id);
    });

    it('clones a version (rules included) into a new draft', async () => {
      const program = await createProgram(t.prisma);
      const v1 = await createPolicy(t.prisma, { programId: program.id, budgetBps: 2500, rules: [{ level: 1, calcType: 'FIXED', fixedAmountMinor: 7_000n }] });
      const d = await draft(su, program.id, { cloneFromVersionId: v1.id, rules: undefined });
      expect(d).toMatchObject({ version: 2, status: 'DRAFT', budgetBps: 2500 });
      expect(d.rules).toEqual([expect.objectContaining({ level: 1, calcType: 'FIXED', fixedAmountMinor: '7000', percentageBps: null })]);
    });

    it('replaces rules atomically, detects stale edits and validates rule shapes', async () => {
      const program = await createProgram(t.prisma);
      const d = await draft(su, program.id);
      const res = await su.patch(`/api/v1/admin/policies/${d.id}`).send({
        expectedUpdatedAt: d.updatedAt,
        budgetBps: 3000,
        rules: [{ level: 1, calcType: 'FIXED', fixedAmountMinor: '5000', percentageBps: 999, capMinor: null }],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const updated = res.body.data as PolicyVersionDto;
      expect(updated.budgetBps).toBe(3000);
      // The field that does not apply to the type is ignored.
      expect(updated.rules).toEqual([expect.objectContaining({ level: 1, calcType: 'FIXED', fixedAmountMinor: '5000', percentageBps: null })]);

      const stale = await su.patch(`/api/v1/admin/policies/${d.id}`).send({ expectedUpdatedAt: d.updatedAt, name: 'Late edit' });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('STALE_VERSION');

      const dup = await su.patch(`/api/v1/admin/policies/${d.id}`).send({
        rules: [
          { level: 1, calcType: 'PERCENTAGE', percentageBps: 100 },
          { level: 1, calcType: 'PERCENTAGE', percentageBps: 200 },
        ],
      });
      expect(dup.status).toBe(400);
      expect(dup.body.error.code).toBe('VALIDATION_FAILED');
      const overCap = await su.patch(`/api/v1/admin/policies/${d.id}`).send({ budgetBps: 5001 });
      expect(overCap.status).toBe(400);

      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'policy.update', resourceId: d.id } });
      expect(audit.programId).toBe(program.id);
      expect(Object.keys(audit.after as object).sort()).toEqual(['budgetBps', 'rules']);
    });

    it('deletes drafts only', async () => {
      const program = await createProgram(t.prisma);
      const d = await draft(su, program.id);
      const published = await createPolicy(t.prisma, { programId: program.id });
      expect((await su.delete(`/api/v1/admin/policies/${published.id}`)).status).toBe(409);
      const res = await su.delete(`/api/v1/admin/policies/${d.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ id: d.id, deleted: true });
      expect(await t.prisma.rewardPolicyVersion.count({ where: { id: d.id } })).toBe(0);
    });
  });

  describe('authorization', () => {
    it('scopes program admins, keeps finance read-only and hides admin routes from members', async () => {
      const program = await createProgram(t.prisma);
      const other = await createProgram(t.prisma);
      const pa = await loginAs(t, await createUser(t.prisma, { roles: ['PROGRAM_ADMIN'], programScopes: [program.id] }));
      const fin = await loginAs(t, await createUser(t.prisma, { roles: ['FINANCE_REVIEWER'] }));
      const member = await loginAs(t, await createUser(t.prisma));

      const d = await draft(pa, program.id);
      expect((await pa.post(`/api/v1/admin/programs/${other.id}/policies`).send({})).status).toBe(403);
      expect((await pa.get(`/api/v1/admin/programs/${other.id}/policies`)).status).toBe(403);

      expect((await fin.get(`/api/v1/admin/policies/${d.id}`)).status).toBe(200);
      expect((await fin.get(`/api/v1/admin/programs/${program.id}/policy-context`)).status).toBe(200);
      const finWrite = await fin.post(`/api/v1/admin/programs/${program.id}/policies`).send({});
      expect(finWrite.status).toBe(403);
      expect(finWrite.body.error.details.missingPermissions).toEqual(['policies:write']);
      expect((await fin.post(`/api/v1/admin/policies/${d.id}/publish`).send({ effectiveFrom: new Date().toISOString() })).status).toBe(403);

      expect((await member.get(`/api/v1/admin/policies/${d.id}`)).status).toBe(403);
    });

    it('requires policies:auto-approve to publish a policy that skips approval', async () => {
      const program = await createProgram(t.prisma);
      const pa = await loginAs(t, await createUser(t.prisma, { roles: ['PROGRAM_ADMIN'], programScopes: [program.id] }));
      const d = await draft(pa, program.id, { requiresApproval: false });

      const denied = await publish(pa, d.id);
      expect(denied.status).toBe(403);
      expect(denied.body.error.details.missingPermissions).toEqual(['policies:auto-approve']);

      const validation = await pa.post(`/api/v1/admin/policies/${d.id}/validate`).send({ effectiveFrom: new Date().toISOString() });
      expect(validation.body.data.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'AUTO_APPROVE_FORBIDDEN', severity: 'error' })]));

      const ok = await publish(su, d.id);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.data.policy).toMatchObject({ status: 'PUBLISHED', requiresApproval: false, publishedBy: { id: superAdmin.id } });
    });
  });

  describe('validation', () => {
    it('reports errors and warnings, including unsaved changes and POINTS break-even', async () => {
      const program = await createProgram(t.prisma, { rewardUnit: 'POINTS', maxRewardDepth: 3 });
      const d = await draft(su, program.id, { pointsPerCurrencyUnit: 2 });
      const res = await su.post(`/api/v1/admin/policies/${d.id}/validate`).send({
        changes: {
          maxDepth: 4,
          budgetBps: 1000,
          rules: [
            { level: 1, calcType: 'FIXED', fixedAmountMinor: '100' },
            { level: 2, calcType: 'PERCENTAGE', percentageBps: 1500 },
          ],
        },
      });
      expect(res.status).toBe(200);
      const codes = (res.body.data.issues as Array<{ code: string; severity: string }>).map((i) => `${i.severity}:${i.code}`);
      expect(res.body.data.valid).toBe(false);
      expect(codes).toEqual(expect.arrayContaining(['error:DEPTH_OUT_OF_RANGE', 'error:PERCENTAGE_OVER_BUDGET', 'warning:FIXED_BREAK_EVEN']));
      // 100 points at 10% → base 1 000 points; 2 points per rupee → ₹500.00.
      const breakEven = res.body.data.issues.find((i: { code: string }) => i.code === 'FIXED_BREAK_EVEN');
      expect(breakEven.message).toContain('500.00');
      // Nothing was saved.
      expect((await su.get(`/api/v1/admin/policies/${d.id}`)).body.data.maxDepth).toBe(3);
    });

    it('refuses to publish an invalid policy with the list of problems', async () => {
      const program = await createProgram(t.prisma);
      const d = await draft(su, program.id, {
        budgetBps: 1000,
        rules: [
          { level: 1, calcType: 'PERCENTAGE', percentageBps: 800 },
          { level: 2, calcType: 'PERCENTAGE', percentageBps: 300 },
        ],
      });
      const res = await publish(su, d.id);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('POLICY_INVALID');
      expect(res.body.error.details.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'PERCENTAGE_OVER_BUDGET' })]));

      const empty = await draft(su, program.id, { rules: [] });
      expect((await publish(su, empty.id)).body.error.details.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'NO_RULES' })]),
      );

      const valid = await draft(su, program.id);
      const past = await publish(su, valid.id, new Date(Date.now() - 10 * 60_000));
      expect(past.status).toBe(400);
      expect(past.body.error.details.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'RETROACTIVE' })]));
    });
  });

  describe('publication timeline', () => {
    it('publishes the first version open-ended and closes it when the next one takes effect', async () => {
      const program = await createProgram(t.prisma);
      const v1 = await draft(su, program.id);
      const r1 = await publish(su, v1.id);
      expect(r1.status, JSON.stringify(r1.body)).toBe(200);
      expect(r1.body.data).toMatchObject({ policy: { status: 'PUBLISHED', phase: 'CURRENT', effectiveTo: null }, closedVersion: null });

      const v2 = await draft(su, program.id, { budgetBps: 1800 });
      const at = new Date(Date.now() + 5_000);
      const r2 = await publish(su, v2.id, at);
      expect(r2.status, JSON.stringify(r2.body)).toBe(200);
      expect(r2.body.data.closedVersion).toEqual({ id: v1.id, version: 1, effectiveTo: at.toISOString() });
      expect(r2.body.data.policy).toMatchObject({ effectiveFrom: at.toISOString(), effectiveTo: null, phase: 'SCHEDULED' });

      const stored = await t.prisma.rewardPolicyVersion.findUniqueOrThrow({ where: { id: v1.id } });
      expect(stored.effectiveTo?.toISOString()).toBe(at.toISOString());
      expect(await t.prisma.auditLog.count({ where: { action: 'policy.close', resourceId: v1.id, programId: program.id } })).toBe(1);
    });

    it('fits a version between the current one and a future-scheduled one', async () => {
      const program = await createProgram(t.prisma);
      const v1 = await draft(su, program.id);
      expect((await publish(su, v1.id)).status).toBe(200);

      const tomorrow = new Date(Date.now() + 24 * HOUR);
      const v2 = await draft(su, program.id);
      expect((await publish(su, v2.id, tomorrow)).status).toBe(200);
      expect((await t.prisma.rewardPolicyVersion.findUniqueOrThrow({ where: { id: v1.id } })).effectiveTo?.toISOString()).toBe(
        tomorrow.toISOString(),
      );

      const inTwoHours = new Date(Date.now() + 2 * HOUR);
      const v3 = await draft(su, program.id);
      const check = await su.post(`/api/v1/admin/policies/${v3.id}/validate`).send({ effectiveFrom: inTwoHours.toISOString() });
      expect(check.body.data.issues.map((i: { code: string }) => i.code)).toEqual(expect.arrayContaining(['CLOSES_CURRENT', 'ENDS_AT_NEXT']));
      const r3 = await publish(su, v3.id, inTwoHours);
      expect(r3.status, JSON.stringify(r3.body)).toBe(200);
      expect(r3.body.data.policy).toMatchObject({ effectiveFrom: inTwoHours.toISOString(), effectiveTo: tomorrow.toISOString() });
      expect(r3.body.data.closedVersion).toMatchObject({ id: v1.id, effectiveTo: inTwoHours.toISOString() });

      const timeline = (await versions(program.id)).map((v) => [v.version, v.phase, v.effectiveFrom ? 'set' : null, v.effectiveTo]);
      expect(timeline).toEqual([
        [3, 'SCHEDULED', 'set', tomorrow.toISOString()],
        [2, 'SCHEDULED', 'set', null],
        [1, 'CURRENT', 'set', inTwoHours.toISOString()],
      ]);

      // Same start as v2 → refused.
      const v4 = await draft(su, program.id);
      const collision = await publish(su, v4.id, tomorrow);
      expect(collision.status).toBe(400);
      expect(collision.body.error.details.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'START_COLLISION' })]));

      const ctx = await su.get(`/api/v1/admin/programs/${program.id}/policy-context`);
      expect(ctx.body.data).toMatchObject({ currentVersionId: v1.id, nextScheduledVersionId: v3.id, hardCapBps: 5000 });
    });

    it('serializes concurrent publications into a non-overlapping timeline', async () => {
      const program = await createProgram(t.prisma);
      const drafts = [await draft(su, program.id), await draft(su, program.id), await draft(su, program.id)];
      const results = await Promise.all(drafts.map((d) => publish(su, d.id)));
      for (const r of results) expect([200, 400], JSON.stringify(r.body)).toContain(r.status);
      expect(results.some((r) => r.status === 200)).toBe(true);
      const live = await t.prisma.rewardPolicyVersion.findMany({
        where: { programId: program.id, status: 'PUBLISHED' },
        orderBy: { effectiveFrom: 'asc' },
      });
      expect(live).toHaveLength(results.filter((r) => r.status === 200).length);
      // Each range ends where the next begins; only the last one is open-ended.
      live.forEach((v, i) => {
        const next = live[i + 1];
        expect(v.effectiveTo?.getTime() ?? null).toBe(next ? next.effectiveFrom.getTime() : null);
      });
    });

    it('makes published versions and their rules immutable', async () => {
      const program = await createProgram(t.prisma);
      const v1 = await draft(su, program.id);
      await publish(su, v1.id);
      const res = await su.patch(`/api/v1/admin/policies/${v1.id}`).send({ budgetBps: 100 });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
      const again = await publish(su, v1.id);
      expect(again.status).toBe(409);
      // The database refuses direct rule edits too.
      await expect(
        t.prisma.rewardRule.updateMany({ where: { policyVersionId: v1.id, level: 1 }, data: { percentageBps: 4000 } }),
      ).rejects.toThrow();
    });

    it('retires the current version now and withdraws a scheduled one', async () => {
      const program = await createProgram(t.prisma);
      const v1 = await draft(su, program.id);
      await publish(su, v1.id);
      const later = new Date(Date.now() + 6 * HOUR);
      const v2 = await draft(su, program.id);
      await publish(su, v2.id, later);

      const shortReason = await su.post(`/api/v1/admin/policies/${v2.id}/retire`).send({ reason: 'short' });
      expect(shortReason.status).toBe(400);

      const withdrawn = await su.post(`/api/v1/admin/policies/${v2.id}/retire`).send({ reason: 'Launch postponed by the business' });
      expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
      expect(withdrawn.body.data).toMatchObject({
        withdrawn: true,
        policy: { status: 'RETIRED', phase: 'WITHDRAWN', effectiveFrom: later.toISOString(), effectiveTo: later.toISOString() },
      });
      expect(withdrawn.body.data.warnings[0]).toMatch(/Version v1 still ends/);

      const before = Date.now();
      const retired = await su.post(`/api/v1/admin/policies/${v1.id}/retire`).send({ reason: 'Replaced by a new commercial plan' });
      expect(retired.status).toBe(200);
      expect(retired.body.data.policy).toMatchObject({ status: 'RETIRED', phase: 'RETIRED' });
      const end = new Date(retired.body.data.policy.effectiveTo).getTime();
      expect(end).toBeGreaterThanOrEqual(before - 1000);
      expect(end).toBeLessThanOrEqual(Date.now() + 1000);
      expect(retired.body.data.warnings[0]).toMatch(/No reward policy is in effect/);

      expect((await su.post(`/api/v1/admin/policies/${v1.id}/retire`).send({ reason: 'Replaced by a new commercial plan' })).status).toBe(409);
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'policy.retire', resourceId: v1.id } });
      expect(audit).toMatchObject({ programId: program.id, reason: 'Replaced by a new commercial plan' });
    });
  });

  describe('dry-run', () => {
    it('previews a synthetic chain without writing anything', async () => {
      const program = await createProgram(t.prisma);
      const d = await draft(su, program.id, {
        maxDepth: 3,
        rules: [...rules, { level: 3, calcType: 'FIXED', fixedAmountMinor: '5000' }],
      });
      const calcBefore = await t.prisma.rewardCalculation.count();
      const res = await su.post(`/api/v1/admin/policies/${d.id}/dry-run`).send({
        eventType: 'PRODUCT_SALE',
        saleAmountMinor: '100000',
        ancestors: [{ eligible: true }, { eligible: false }, { eligible: true }],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const r = res.body.data as DryRunResultDto;
      expect(r).toMatchObject({ mode: 'SYNTHETIC', applicable: true, budgetMinor: '20000', hardCapMinor: '50000', totalAllocatedMinor: '15000' });
      expect(r.allocations.map((a) => [a.level, a.amountMinor])).toEqual([
        [1, '10000'],
        [3, '5000'],
      ]);
      expect(r.levels[1]).toMatchObject({ level: 2, decision: 'INELIGIBLE_FORFEITED' });
      expect(await t.prisma.rewardCalculation.count()).toBe(calcBefore);

      // Unsaved changes of a draft are previewed too.
      const changed = await su.post(`/api/v1/admin/policies/${d.id}/dry-run`).send({
        eventType: 'PRODUCT_SALE',
        saleAmountMinor: '100000',
        ancestors: [{ eligible: true }],
        changes: { rules: [{ level: 1, calcType: 'PERCENTAGE', percentageBps: 2000 }] },
      });
      expect(changed.body.data.allocations[0].amountMinor).toBe('20000');

      const both = await su.post(`/api/v1/admin/policies/${d.id}/dry-run`).send({ eventType: 'PRODUCT_SALE', saleAmountMinor: '1' });
      expect(both.status).toBe(400);
    });

    it('matches real processing for the same sale (real tree + eligibility)', async () => {
      const program = await createProgram(t.prisma);
      const anita = await createUser(t.prisma, { fullName: 'Anita Sharma' });
      const rahul = await createUser(t.prisma, { fullName: 'Rahul Verma', sponsor: anita });
      const kiran = await createUser(t.prisma, { fullName: 'Kiran Rao', sponsor: rahul });
      const priya = await createUser(t.prisma, { fullName: 'Priya Nair', sponsor: kiran });
      // Kiran (level 1) has no enrollment → FORFEIT; Rahul (2) and Anita (3) are eligible.
      await createEnrollment(t.prisma, { userId: rahul.id, programId: program.id });
      await createEnrollment(t.prisma, { userId: anita.id, programId: program.id });
      const d = await draft(su, program.id, {
        maxDepth: 3,
        budgetBps: 2500,
        rules: [
          { level: 1, calcType: 'PERCENTAGE', percentageBps: 1000 },
          { level: 2, calcType: 'PERCENTAGE', percentageBps: 700, capMinor: '5000' },
          { level: 3, calcType: 'FIXED', fixedAmountMinor: '3333' },
        ],
      });
      expect((await publish(su, d.id)).status).toBe(200);

      const occurredAt = new Date(Date.now() + 2_000);
      const preview = await su.post(`/api/v1/admin/policies/${d.id}/dry-run`).send({
        eventType: 'PRODUCT_SALE',
        saleAmountMinor: '123457',
        subjectUserId: priya.id,
        occurredAt: occurredAt.toISOString(),
      });
      expect(preview.status, JSON.stringify(preview.body)).toBe(200);
      const p = preview.body.data as DryRunResultDto;
      expect(p.ancestors.map((a) => [a.displayName, a.eligible])).toEqual([
        ['Kiran R.', false],
        ['Rahul V.', true],
        ['Anita S.', true],
      ]);

      const sale = await su.post('/api/v1/admin/events').send({
        programId: program.id,
        type: 'PRODUCT_SALE',
        externalId: 'ORD-DRY-1',
        customerReference: 'CUST-1',
        subjectUserId: priya.id,
        amountMinor: '123457',
        occurredAt: occurredAt.toISOString(),
      });
      expect(sale.status, JSON.stringify(sale.body)).toBe(201);
      const real = sale.body.data as RecordSaleResultDto;
      expect(real.outcome).toBe('REWARDS_CREATED');
      expect(real.event.rewards.map((r) => [r.level, r.recipient.id, r.amountMinor])).toEqual(
        p.allocations.map((a) => [a.level, a.userId, a.amountMinor]),
      );
      expect(real.event.calculation).toMatchObject({ baseMinor: p.baseMinor, budgetMinor: p.budgetMinor, totalAllocatedMinor: p.totalAllocatedMinor });
      expect(p.allocations.map((a) => a.amountMinor)).toEqual(['5000', '3333']);
    });

    it("a PROGRAM_ADMIN can preview only subjects enrolled in the policy's program (else 404)", async () => {
      const program = await createProgram(t.prisma);
      const other = await createProgram(t.prisma);
      const pa = await loginAs(t, await createUser(t.prisma, { roles: ['PROGRAM_ADMIN'], programScopes: [program.id, other.id] }));
      const sponsor = await createUser(t.prisma, { fullName: 'Secret Sponsor' });
      const outsider = await createUser(t.prisma, { fullName: 'Not Enrolled', sponsor });
      const elsewhere = await createUser(t.prisma, { fullName: 'Other Program', sponsor });
      const insider = await createUser(t.prisma, { fullName: 'In Program', sponsor });
      await createEnrollment(t.prisma, { userId: elsewhere.id, programId: other.id });
      await createEnrollment(t.prisma, { userId: insider.id, programId: program.id });
      const d = await draft(pa, program.id);
      const preview = (subjectUserId: string, client: LoggedInClient = pa) =>
        client.post(`/api/v1/admin/policies/${d.id}/dry-run`).send({ eventType: 'PRODUCT_SALE', saleAmountMinor: '100000', subjectUserId });

      for (const subject of [outsider.id, elsewhere.id, '00000000-0000-4000-8000-000000000000']) {
        const res = await preview(subject);
        expect(res.status, JSON.stringify(res.body)).toBe(404);
        expect(JSON.stringify(res.body)).not.toContain('Secret');
      }
      const ok = await preview(insider.id);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect((ok.body.data as DryRunResultDto).ancestors.map((a) => a.displayName)).toEqual(['Secret S.']);
      // unscoped callers may preview any member
      expect((await preview(outsider.id, su)).status).toBe(200);
    });
  });

  describe('member transparency', () => {
    it('shows the current levels and budget without internal fields', async () => {
      const program = await createProgram(t.prisma);
      const member = await loginAs(t, await createUser(t.prisma));
      expect((await member.get(`/api/v1/programs/${program.id}/policy`)).body).toEqual({ data: null });

      await createPolicy(t.prisma, { programId: program.id, budgetBps: 1500, name: 'Internal name', requiresApproval: true });
      const res = await member.get(`/api/v1/programs/${program.id}/policy`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        programId: program.id,
        version: 1,
        budgetBps: 1500,
        hardCapBps: 5000,
        inEffect: true,
        currencyCode: 'INR',
        levels: [
          { level: 1, calcType: 'PERCENTAGE', percentageBps: 1000, fixedAmountMinor: null, capMinor: null },
          { level: 2, calcType: 'PERCENTAGE', percentageBps: 500, fixedAmountMinor: null, capMinor: null },
        ],
      });
      for (const key of ['name', 'notes', 'requiresApproval', 'publishedBy', 'createdBy', 'id']) {
        expect(res.body.data).not.toHaveProperty(key);
      }

      const draftProgram = await createProgram(t.prisma, { status: 'DRAFT' });
      expect((await member.get(`/api/v1/programs/${draftProgram.id}/policy`)).status).toBe(404);
      expect((await t.client().get(`/api/v1/programs/${program.id}/policy`)).status).toBe(401);
    });
  });
});
