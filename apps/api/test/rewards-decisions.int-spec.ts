import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import { createUser, factoryAdmin, loginAs } from './utils/factories';
import { adminClient, anotherSale, idemKey, ledgerOf, saleScenario } from './finance-fixtures';

describe('admin reward decisions (approve / reject / bulk / reverse)', () => {
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

  const reviewer = () => adminClient(t, ['FINANCE_REVIEWER'], { fullName: 'Fiona Reviewer' });

  describe('approve', () => {
    it('approves and posts exactly once in one transaction (ledger, audit, notification)', async () => {
      const s = await saleScenario(t);
      const { user, client } = await reviewer();
      const reward = s.rewards[0]!;

      const res = await client.post(`/api/v1/admin/rewards/${reward.id}/approve`).set('Idempotency-Key', idemKey());
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: reward.id, status: 'POSTED', ledgerTransaction: { type: 'REWARD_POSTING' } });

      const row = await t.prisma.reward.findUniqueOrThrow({ where: { id: reward.id } });
      expect(row).toMatchObject({ status: 'POSTED', approvedById: user.id });
      expect(row.postedAt).not.toBeNull();
      const txns = await ledgerOf(t, reward.id);
      expect(txns).toHaveLength(1);
      expect(txns[0]!.id).toBe(res.body.data.ledgerTransaction.id);
      expect(txns[0]!.entries.map((e) => [e.direction, e.account.type, e.amountMinor]).sort()).toEqual([
        ['CREDIT', 'MEMBER_REWARDS_PAYABLE', 10_000n],
        ['DEBIT', 'PLATFORM_REWARD_EXPENSE', 10_000n],
      ]);
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'reward.approve', resourceId: reward.id } });
      expect(audit).toMatchObject({ actorUserId: user.id, programId: s.program.id });
      const notices = await t.prisma.outboxMessage.findMany({ where: { dedupeKey: `notification:reward-posted:${reward.id}` } });
      expect(notices).toHaveLength(1);
      expect((notices[0]!.payload as { userId: string }).userId).toBe(s.rahul.id);
    });

    it('requires an Idempotency-Key and replays the stored response for the same key', async () => {
      const s = await saleScenario(t);
      const { client } = await reviewer();
      const url = `/api/v1/admin/rewards/${s.rewards[0]!.id}/approve`;

      const missing = await client.post(url);
      expect(missing.status).toBe(400);

      const key = idemKey();
      const first = await client.post(url).set('Idempotency-Key', key);
      const replay = await client.post(url).set('Idempotency-Key', key);
      expect(first.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect(await t.prisma.ledgerTransaction.count({ where: { rewardId: s.rewards[0]!.id } })).toBe(1);

      // A new key is a new intent: the reward is already posted.
      const again = await client.post(url).set('Idempotency-Key', idemKey());
      expect(again.status).toBe(409);
      expect(again.body.error).toMatchObject({ code: 'INVALID_STATE_TRANSITION', message: 'This reward has already been approved and posted.' });
    });

    it('posts exactly once under concurrent approvals by different reviewers', async () => {
      const s = await saleScenario(t);
      const reviewers = await Promise.all([reviewer(), reviewer(), reviewer()]);
      const url = `/api/v1/admin/rewards/${s.rewards[0]!.id}/approve`;
      const results = await Promise.all(reviewers.map(({ client }) => client.post(url).set('Idempotency-Key', idemKey())));
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409, 409]);
      for (const r of results.filter((x) => x.status === 409)) expect(r.body.error.code).toBe('INVALID_STATE_TRANSITION');
      expect(await t.prisma.ledgerTransaction.count({ where: { rewardId: s.rewards[0]!.id } })).toBe(1);
      expect(await t.prisma.auditLog.count({ where: { action: 'reward.approve' } })).toBe(1);
    });
  });

  describe('segregation of duties', () => {
    it('refuses a decision on your own reward with a friendly 409 (before the DB)', async () => {
      const s = await saleScenario(t, { rahul: { roles: ['FINANCE_REVIEWER'] } });
      const rahulClient = await loginAs(t, s.rahul);
      const own = s.rewards[0]!;
      for (const [path, body] of [
        ['approve', undefined],
        ['reject', { reason: 'Not a valid sale at all' }],
      ] as const) {
        const res = await rahulClient.post(`/api/v1/admin/rewards/${own.id}/${path}`).set('Idempotency-Key', idemKey()).send(body);
        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({
          code: 'CONFLICT',
          details: { reason: 'SEGREGATION_OF_DUTIES', rule: 'OWN_REWARD' },
        });
        expect(res.body.error.message).toMatch(/Another reviewer/);
      }
      // …but may approve the upline's reward from the same sale.
      const other = await rahulClient.post(`/api/v1/admin/rewards/${s.rewards[1]!.id}/approve`).set('Idempotency-Key', idemKey());
      expect(other.status).toBe(200);
    });

    it('refuses approval by the admin who recorded the sale', async () => {
      const s = await saleScenario(t);
      const recorder = await loginAs(t, await factoryAdmin(t.prisma));
      const res = await recorder.post(`/api/v1/admin/rewards/${s.rewards[0]!.id}/approve`).set('Idempotency-Key', idemKey());
      expect(res.status).toBe(409);
      expect(res.body.error.details).toMatchObject({ reason: 'SEGREGATION_OF_DUTIES', rule: 'RECORDED_SALE' });
      expect((await t.prisma.reward.findUniqueOrThrow({ where: { id: s.rewards[0]!.id } })).status).toBe('PENDING_APPROVAL');
    });
  });

  describe('reject and reverse', () => {
    it('rejects with a reason (no ledger) and validates the reason', async () => {
      const s = await saleScenario(t);
      const { user, client } = await reviewer();
      const id = s.rewards[1]!.id;

      const tooShort = await client.post(`/api/v1/admin/rewards/${id}/reject`).set('Idempotency-Key', idemKey()).send({ reason: 'no' });
      expect(tooShort.status).toBe(400);

      const res = await client
        .post(`/api/v1/admin/rewards/${id}/reject`)
        .set('Idempotency-Key', idemKey())
        .send({ reason: 'Duplicate of an earlier sale' });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ id, status: 'REJECTED', ledgerTransaction: null });
      expect(await t.prisma.reward.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: 'REJECTED',
        rejectedById: user.id,
        rejectionReason: 'Duplicate of an earlier sale',
      });
      expect(await t.prisma.ledgerTransaction.count({ where: { rewardId: id } })).toBe(0);
      expect(await t.prisma.auditLog.findFirst({ where: { action: 'reward.reject', resourceId: id } })).toMatchObject({
        reason: 'Duplicate of an earlier sale',
      });

      const twice = await client.post(`/api/v1/admin/rewards/${id}/approve`).set('Idempotency-Key', idemKey());
      expect(twice.status).toBe(409);
      expect(twice.body.error.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('reverses a posted reward with a mirrored ledger transaction; pending rewards cannot be reversed', async () => {
      const s = await saleScenario(t);
      const { user, client } = await reviewer();
      const [posted, pending] = s.rewards;
      await client.post(`/api/v1/admin/rewards/${posted!.id}/approve`).set('Idempotency-Key', idemKey()).expect(200);

      const bad = await client
        .post(`/api/v1/admin/rewards/${pending!.id}/reverse`)
        .set('Idempotency-Key', idemKey())
        .send({ reason: 'Customer refund issued' });
      expect(bad.status).toBe(409);
      expect(bad.body.error.message).toMatch(/Only posted rewards can be reversed/);

      const res = await client
        .post(`/api/v1/admin/rewards/${posted!.id}/reverse`)
        .set('Idempotency-Key', idemKey())
        .send({ reason: 'Customer refund issued' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'REVERSED', ledgerTransaction: { type: 'REWARD_REVERSAL' } });
      expect(await t.prisma.reward.findUniqueOrThrow({ where: { id: posted!.id } })).toMatchObject({
        status: 'REVERSED',
        reversedById: user.id,
        reversalReason: 'Customer refund issued',
      });
      const txns = await ledgerOf(t, posted!.id);
      expect(txns.map((x) => x.type)).toEqual(['REWARD_POSTING', 'REWARD_REVERSAL']);
      expect(txns[1]!.reversesTransactionId).toBe(txns[0]!.id);
    });

    it('a program admin (rewards:read only) cannot decide', async () => {
      const s = await saleScenario(t);
      const { client } = await adminClient(t, ['PROGRAM_ADMIN'], { programScopes: [s.program.id] });
      const res = await client.post(`/api/v1/admin/rewards/${s.rewards[0]!.id}/approve`).set('Idempotency-Key', idemKey());
      expect(res.status).toBe(403);
      expect(res.body.error.details).toMatchObject({ missingPermissions: ['rewards:approve'] });
    });
  });

  describe('bulk approve', () => {
    it('processes each reward in its own transaction and reports per-item results', async () => {
      const s = await saleScenario(t, { rahul: { roles: ['FINANCE_REVIEWER'] } });
      const second = await anotherSale(t, s);
      const rahulClient = await loginAs(t, s.rahul);
      // Pre-post one reward so it fails as "already posted".
      const { client: other } = await reviewer();
      await other.post(`/api/v1/admin/rewards/${second.rewards[1]!.id}/approve`).set('Idempotency-Key', idemKey()).expect(200);

      const missing = '00000000-0000-4000-8000-000000000000';
      const ids = [s.rewards[1]!.id, s.rewards[0]!.id, second.rewards[1]!.id, missing];
      const res = await rahulClient.post('/api/v1/admin/rewards/bulk-approve').set('Idempotency-Key', idemKey()).send({ ids });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ approved: 1, failed: 3 });
      const byId = new Map(res.body.data.results.map((r: { id: string }) => [r.id, r]));
      expect(byId.get(s.rewards[1]!.id)).toMatchObject({ ok: true, status: 'POSTED' });
      expect(byId.get(s.rewards[0]!.id)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } }); // own reward
      expect(byId.get(second.rewards[1]!.id)).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } });
      expect(byId.get(missing)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      expect(await t.prisma.reward.findUniqueOrThrow({ where: { id: s.rewards[1]!.id } })).toMatchObject({ status: 'POSTED' });
    });

    it('validates the id list', async () => {
      const { client } = await reviewer();
      const post = (body: object) => client.post('/api/v1/admin/rewards/bulk-approve').set('Idempotency-Key', idemKey()).send(body);
      expect((await post({ ids: [] })).status).toBe(400);
      const id = '00000000-0000-4000-8000-000000000001';
      expect((await post({ ids: [id, id] })).status).toBe(400);
      expect((await post({ ids: Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) })).status).toBe(400);
    });
  });

  describe('queue, counts and detail', () => {
    it('lists with filters, counts per status and shows the detail with a readable trace', async () => {
      const s = await saleScenario(t);
      const { client } = await reviewer();
      await client.post(`/api/v1/admin/rewards/${s.rewards[0]!.id}/approve`).set('Idempotency-Key', idemKey()).expect(200);

      const pending = await client.get('/api/v1/admin/rewards?status=PENDING_APPROVAL');
      expect(pending.status).toBe(200);
      expect(pending.body.data.map((r: { id: string }) => r.id)).toEqual([s.rewards[1]!.id]);
      expect(pending.body.data[0]).toMatchObject({
        level: 2,
        amountMinor: '5000',
        rewardUnit: 'MONEY',
        currencyCode: 'INR',
        currencyMinorUnits: 2,
        recipient: { id: s.anita.id, fullName: 'Anita Sharma' },
        event: { amountMinor: '100000', subject: { id: s.priya.id } },
        viewer: { isRecipient: false, recordedSale: false },
      });

      const byName = await client.get('/api/v1/admin/rewards?q=rahul');
      expect(byName.body.data.map((r: { id: string }) => r.id)).toEqual([s.rewards[0]!.id]);

      const page = await client.get('/api/v1/admin/rewards?limit=1&order=asc');
      expect(page.body.data).toHaveLength(1);
      expect(page.body.page.nextCursor).toEqual(expect.any(String));
      const page2 = await client.get(`/api/v1/admin/rewards?limit=1&order=asc&cursor=${page.body.page.nextCursor}`);
      expect(page2.body.data[0].id).not.toBe(page.body.data[0].id);
      expect((await client.get('/api/v1/admin/rewards?cursor=garbage!')).status).toBe(400);

      const counts = await client.get(`/api/v1/admin/rewards/counts?programId=${s.program.id}`);
      expect(counts.body.data).toMatchObject({ total: 2, byStatus: { PENDING_APPROVAL: 1, POSTED: 1, REJECTED: 0 } });

      const facets = await client.get('/api/v1/admin/rewards/facets');
      expect(facets.body.data.programs).toEqual([expect.objectContaining({ id: s.program.id, name: 'Spring Promo' })]);

      const detail = await client.get(`/api/v1/admin/rewards/${s.rewards[0]!.id}`);
      expect(detail.status).toBe(200);
      const d = detail.body.data;
      expect(d.calculation).toMatchObject({ baseMinor: '100000', budgetBps: 2000, budgetMinor: '20000', totalAllocatedMinor: '15000' });
      expect(d.calculation.trace.parsed).toBe(true);
      expect(d.calculation.trace.levels.map((l: { level: number; decision: string; user: { fullName: string } }) => [l.level, l.decision, l.user.fullName])).toEqual([
        [1, 'AWARDED', 'Rahul Verma'],
        [2, 'AWARDED', 'Anita Sharma'],
      ]);
      expect(d.calculation.trace.levels[0].isThisReward).toBe(true);
      expect(d.siblings).toEqual([expect.objectContaining({ id: s.rewards[1]!.id, level: 2 })]);
      expect(d.ledgerTransactions).toHaveLength(1);
      expect(d.ledgerTransactions[0].entries).toHaveLength(2);
      expect(d.auditTrail.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['event.processed', 'reward.approve']));
      expect(d.event.customerReference).toEqual(expect.any(String));
    });

    it('scopes program admins to their programs and refuses members and admins without TOTP', async () => {
      const s = await saleScenario(t);
      const scoped = await adminClient(t, ['PROGRAM_ADMIN'], { programScopes: [s.program.id] });
      expect((await scoped.client.get('/api/v1/admin/rewards')).body.data).toHaveLength(2);
      expect((await scoped.client.get(`/api/v1/admin/rewards/${s.rewards[0]!.id}`)).status).toBe(200);

      const outsider = await adminClient(t, ['PROGRAM_ADMIN'], { programScopes: [] });
      expect((await outsider.client.get('/api/v1/admin/rewards')).body.data).toEqual([]);
      expect((await outsider.client.get(`/api/v1/admin/rewards/${s.rewards[0]!.id}`)).status).toBe(403);
      expect((await outsider.client.get(`/api/v1/admin/rewards?programId=${s.program.id}`)).status).toBe(403);
      expect((await outsider.client.get('/api/v1/admin/rewards/facets')).body.data.programs).toEqual([]);

      const member = await loginAs(t, s.priya);
      expect((await member.get('/api/v1/admin/rewards')).status).toBe(403);

      const noTotp = await createUser(t.prisma, { roles: ['FINANCE_REVIEWER'] });
      const emailOnly = await loginAs(t, noTotp, { mfa: 'EMAIL_OTP' });
      const res = await emailOnly.get('/api/v1/admin/rewards');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('MFA_REQUIRED');

      expect((await t.client().get('/api/v1/admin/rewards')).status).toBe(401);
    });
  });
});
