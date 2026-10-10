import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EnrollmentsService } from '../src/modules/enrollments/enrollments.service';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { HierarchyService } from '../src/modules/referrals/hierarchy.service';
import { ReferralsService } from '../src/modules/referrals/referrals.service';
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
  type CreatePolicyOptions,
  type CreateProgramOptions,
  type TestUser,
} from './utils/factories';

describe('cross-module services: referrals, eligibility, ledger, reward engine', () => {
  let t: TestApp;
  let referrals: ReferralsService;
  let hierarchy: HierarchyService;
  let enrollments: EnrollmentsService;
  let ledger: LedgerService;
  let engine: RewardEngineService;

  beforeAll(async () => {
    t = await createTestApp();
    referrals = t.get(ReferralsService);
    hierarchy = t.get(HierarchyService);
    enrollments = t.get(EnrollmentsService);
    ledger = t.get(LedgerService);
    engine = t.get(RewardEngineService);
  });
  beforeEach(async () => {
    await resetDatabase();
    await factoryAdmin(t.prisma);
  });
  afterAll(async () => {
    await t.close();
    await disconnectTestPrisma();
  });

  /** Anita > Rahul > Priya, plus an unrelated admin who records sales. */
  async function chain() {
    const anita = await createUser(t.prisma, { fullName: 'Anita Sharma' });
    const rahul = await createUser(t.prisma, { fullName: 'Rahul Verma', sponsor: anita });
    const priya = await createUser(t.prisma, { fullName: 'Priya Nair', sponsor: rahul });
    return { anita, rahul, priya };
  }

  async function programWithPolicy(opts: Partial<CreatePolicyOptions> = {}, programOpts: CreateProgramOptions = {}) {
    const program = await createProgram(t.prisma, programOpts);
    const policy = await createPolicy(t.prisma, { programId: program.id, ...opts });
    return { program, policy };
  }

  async function enroll(users: TestUser[], programId: string) {
    for (const u of users) await createEnrollment(t.prisma, { userId: u.id, programId });
  }

  describe('ReferralsService', () => {
    async function registerInTx(sponsorCode: string | null) {
      const id = randomUUID();
      const result = await t.prisma.$transaction(async (tx) => {
        await tx.user.create({
          data: { id, email: `new-${id}@example.test`, fullName: 'New Member', status: 'ACTIVE', emailVerifiedAt: new Date() },
        });
        const resolved = sponsorCode ? await referrals.resolveCodeForRegistration(tx, sponsorCode) : null;
        return referrals.attachNewMember(tx, {
          userId: id,
          sponsorUserId: resolved?.sponsorUserId ?? null,
          referralCodeId: resolved?.referralCodeId ?? null,
          registrationIp: '203.0.113.7',
          registrationUserAgent: 'vitest',
        });
      });
      return { id, ...result };
    }

    it('attaches a new member under the sponsor with a full closure chain and a fresh code', async () => {
      const { anita, rahul } = await chain();
      const code = (await t.prisma.referralCode.findFirstOrThrow({ where: { userId: rahul.id } })).code;
      const created = await registerInTx(` ${code.toLowerCase()} `);

      expect(created.referralCode).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
      const paths = await t.prisma.referralPath.findMany({ where: { descendantId: created.id }, orderBy: { depth: 'asc' } });
      expect(paths.map((p) => [p.ancestorId, p.depth])).toEqual([
        [created.id, 0],
        [rahul.id, 1],
        [anita.id, 2],
      ]);
      const rel = await t.prisma.referralRelationship.findUniqueOrThrow({ where: { childUserId: created.id } });
      expect(rel.sponsorUserId).toBe(rahul.id);
      expect(rel.registrationIp).toBe('203.0.113.7');
    });

    it('attaches a root member when no code is given', async () => {
      const created = await registerInTx(null);
      expect(await t.prisma.referralPath.count({ where: { descendantId: created.id } })).toBe(1);
      expect(await t.prisma.referralRelationship.count({ where: { childUserId: created.id } })).toBe(0);
    });

    it('rejects unknown, inactive and suspended-owner codes with the same error', async () => {
      const owner = await createUser(t.prisma);
      const code = (await t.prisma.referralCode.findFirstOrThrow({ where: { userId: owner.id } })).code;
      await expect(registerInTx('NOPE2345')).rejects.toMatchObject({ code: 'REFERRAL_CODE_INVALID' });
      await t.prisma.user.update({ where: { id: owner.id }, data: { status: 'SUSPENDED', suspendedAt: new Date() } });
      await expect(registerInTx(code)).rejects.toMatchObject({ code: 'REFERRAL_CODE_INVALID' });
    });

    it('lists ancestors in depth order with a depth limit', async () => {
      const { anita, rahul, priya } = await chain();
      expect(await hierarchy.getAncestors(t.prisma, priya.id, 10)).toEqual([
        { userId: rahul.id, depth: 1 },
        { userId: anita.id, depth: 2 },
      ]);
      expect(await hierarchy.getAncestors(t.prisma, priya.id, 1)).toEqual([{ userId: rahul.id, depth: 1 }]);
      expect(await hierarchy.getAncestors(t.prisma, anita.id, 10)).toEqual([]);
    });
  });

  describe('EnrollmentsService.findEligibleEnrollments', () => {
    it('uses the coverage period at the sale instant', async () => {
      const { anita, rahul, priya } = await chain();
      const program = await createProgram(t.prisma);
      const active = await createEnrollment(t.prisma, { userId: anita.id, programId: program.id });
      await createEnrollment(t.prisma, { userId: rahul.id, programId: program.id, status: 'PENDING' });
      const cancelled = await createEnrollment(t.prisma, { userId: priya.id, programId: program.id, status: 'CANCELLED' });

      const now = new Date(Date.now() + 1000);
      const found = await enrollments.findEligibleEnrollments(t.prisma, program.id, [anita.id, rahul.id, priya.id], now);
      expect(found.get(anita.id)?.enrollmentId).toBe(active.id);
      expect(found.has(rahul.id)).toBe(false); // pending: no coverage
      expect(found.has(priya.id)).toBe(false); // cancelled before `now`
      void cancelled;

      const before = new Date(Date.now() - 120_000);
      expect((await enrollments.findEligibleEnrollments(t.prisma, program.id, [anita.id], before)).size).toBe(0);
    });
  });

  describe('RewardEngineService.processEvent', () => {
    it('creates pending rewards for eligible uplines (manual sale) and is idempotent', async () => {
      const { anita, rahul, priya } = await chain();
      const { program, policy } = await programWithPolicy();
      await enroll([anita, rahul], program.id);
      const event = await createEvent(t.prisma, { programId: program.id, subjectUserId: priya.id, amountMinor: 100_000n });

      const res = await engine.processEvent(event.id);
      expect(res.outcome).toBe('REWARDS_CREATED');
      const rewards = await t.prisma.reward.findMany({ where: { eventId: event.id }, orderBy: { level: 'asc' } });
      expect(rewards.map((r) => [r.level, r.recipientUserId, r.amountMinor, r.status])).toEqual([
        [1, rahul.id, 10_000n, 'PENDING_APPROVAL'],
        [2, anita.id, 5_000n, 'PENDING_APPROVAL'],
      ]);
      const calc = await t.prisma.rewardCalculation.findUniqueOrThrow({ where: { eventId: event.id } });
      expect(calc).toMatchObject({ policyVersionId: policy.id, baseMinor: 100_000n, budgetMinor: 20_000n, totalAllocatedMinor: 15_000n });
      const ev = await t.prisma.qualifyingEvent.findUniqueOrThrow({ where: { id: event.id } });
      expect(ev).toMatchObject({ status: 'PROCESSED', policyVersionId: policy.id });
      expect(await t.prisma.outboxMessage.count({ where: { topic: 'notification.create' } })).toBe(2);

      expect(await engine.processEvent(event.id)).toEqual({ outcome: 'ALREADY_PROCESSED', rewardIds: [] });
      expect(await t.prisma.rewardCalculation.count()).toBe(1);
    });

    it('serializes concurrent processing to exactly one calculation', async () => {
      const { anita, rahul, priya } = await chain();
      const { program } = await programWithPolicy();
      await enroll([anita, rahul], program.id);
      const event = await createEvent(t.prisma, { programId: program.id, subjectUserId: priya.id });

      const outcomes = (await Promise.all([engine.processEvent(event.id), engine.processEvent(event.id)])).map((r) => r.outcome);
      expect(outcomes.sort()).toEqual(['ALREADY_PROCESSED', 'REWARDS_CREATED']);
      expect(await t.prisma.rewardCalculation.count()).toBe(1);
      expect(await t.prisma.reward.count()).toBe(2);
    });

    it('auto-approves and posts integration sales under a no-approval policy', async () => {
      const { anita, rahul, priya } = await chain();
      const { program } = await programWithPolicy({ requiresApproval: false });
      await enroll([anita, rahul], program.id);
      const event = await createEvent(t.prisma, { programId: program.id, subjectUserId: priya.id, source: 'API', amountMinor: 50_000n });

      await engine.processEvent(event.id);
      const rewards = await t.prisma.reward.findMany({ where: { eventId: event.id } });
      expect(rewards.every((r) => r.status === 'POSTED' && r.approvedById === null && r.postedAt)).toBe(true);
      const balances = await t.prisma.$queryRaw<Array<{ user_id: string | null; credits_minor: bigint; debits_minor: bigint }>>`
        SELECT "user_id", "credits_minor", "debits_minor" FROM "ledger_account_balances" ORDER BY "user_id" NULLS FIRST`;
      const byUser = new Map(balances.map((b) => [b.user_id, b]));
      expect(byUser.get(null)?.debits_minor).toBe(7_500n);
      expect(byUser.get(rahul.id)?.credits_minor).toBe(5_000n);
      expect(byUser.get(anita.id)?.credits_minor).toBe(2_500n);
    });

    it('still requires manual approval for manually recorded sales under a no-approval policy', async () => {
      const { anita, rahul, priya } = await chain();
      const { program } = await programWithPolicy({ requiresApproval: false });
      await enroll([anita, rahul], program.id);
      const event = await createEvent(t.prisma, { programId: program.id, subjectUserId: priya.id });
      await engine.processEvent(event.id);
      expect(new Set((await t.prisma.reward.findMany()).map((r) => r.status))).toEqual(new Set(['PENDING_APPROVAL']));
      expect(await t.prisma.ledgerTransaction.count()).toBe(0);
    });

    it('FORFEIT skips an ineligible upline; COMPRESS moves the next eligible one up', async () => {
      const { anita, rahul, priya } = await chain();
      const forfeit = await programWithPolicy({}, { code: 'forfeit' });
      await enroll([anita], forfeit.program.id); // rahul not enrolled
      const e1 = await createEvent(t.prisma, { programId: forfeit.program.id, subjectUserId: priya.id, amountMinor: 100_000n });
      await engine.processEvent(e1.id);
      expect((await t.prisma.reward.findMany({ where: { eventId: e1.id } })).map((r) => [r.level, r.recipientUserId])).toEqual([
        [2, anita.id],
      ]);

      const compress = await programWithPolicy({ ineligibleAncestorBehavior: 'COMPRESS' }, { code: 'compress' });
      await enroll([anita], compress.program.id);
      const e2 = await createEvent(t.prisma, { programId: compress.program.id, subjectUserId: priya.id, amountMinor: 100_000n });
      await engine.processEvent(e2.id);
      expect(
        (await t.prisma.reward.findMany({ where: { eventId: e2.id } })).map((r) => [r.level, r.recipientUserId, r.amountMinor]),
      ).toEqual([[1, anita.id, 10_000n]]);
    });

    it('converts sale value to points for POINTS programs using the policy rate', async () => {
      const { anita, rahul, priya } = await chain();
      const { program } = await programWithPolicy({ pointsPerCurrencyUnit: 2 }, { rewardUnit: 'POINTS' });
      await enroll([anita, rahul], program.id);
      const event = await createEvent(t.prisma, { programId: program.id, subjectUserId: priya.id, amountMinor: 250_000n });
      await engine.processEvent(event.id);
      const calc = await t.prisma.rewardCalculation.findUniqueOrThrow({ where: { eventId: event.id } });
      expect(calc).toMatchObject({ rewardUnit: 'POINTS', baseMinor: 5_000n, pointsPerCurrencyUnit: 2 });
      expect((await t.prisma.reward.findMany({ orderBy: { level: 'asc' } })).map((r) => r.amountMinor)).toEqual([500n, 250n]);
    });

    it('records NO_ELIGIBLE_RECIPIENTS for a root member', async () => {
      const { anita } = await chain();
      const { program } = await programWithPolicy();
      const event = await createEvent(t.prisma, { programId: program.id, subjectUserId: anita.id });
      expect((await engine.processEvent(event.id)).outcome).toBe('NO_ELIGIBLE_RECIPIENTS');
      expect(await t.prisma.rewardCalculation.findUniqueOrThrow({ where: { eventId: event.id } })).toMatchObject({
        outcome: 'NO_ELIGIBLE_RECIPIENTS',
        totalAllocatedMinor: 0n,
      });
    });

    it('rejects a sale when no policy applies or the subject is not active', async () => {
      const { rahul, priya } = await chain();
      const program = await createProgram(t.prisma);
      const noPolicy = await createEvent(t.prisma, { programId: program.id, subjectUserId: priya.id });
      expect(await engine.processEvent(noPolicy.id)).toMatchObject({ outcome: 'REJECTED', rejectionReason: 'No reward policy applies to the sale date' });

      await createPolicy(t.prisma, { programId: program.id });
      const suspendedSubject = await createEvent(t.prisma, { programId: program.id, subjectUserId: rahul.id });
      await t.prisma.user.update({ where: { id: rahul.id }, data: { status: 'SUSPENDED', suspendedAt: new Date() } });
      expect((await engine.processEvent(suspendedSubject.id)).outcome).toBe('REJECTED');
      expect((await t.prisma.qualifyingEvent.findUniqueOrThrow({ where: { id: suspendedSubject.id } })).status).toBe('REJECTED');
    });
  });

  describe('LedgerService', () => {
    async function pendingRewards() {
      const { anita, rahul, priya } = await chain();
      const { program } = await programWithPolicy();
      await enroll([anita, rahul], program.id);
      const event = await createEvent(t.prisma, { programId: program.id, subjectUserId: priya.id, amountMinor: 100_000n });
      await engine.processEvent(event.id);
      const reviewer = await createUser(t.prisma, { roles: ['FINANCE_REVIEWER'] });
      const rewards = await t.prisma.reward.findMany({ where: { eventId: event.id }, orderBy: { level: 'asc' } });
      return { reviewer, rewards, event };
    }

    async function approve(rewardId: string, reviewerId: string) {
      await t.prisma.reward.update({ where: { id: rewardId }, data: { status: 'APPROVED', approvedById: reviewerId, approvedAt: new Date() } });
    }

    it('posts once (idempotent) and reverses with a mirrored transaction', async () => {
      const { reviewer, rewards } = await pendingRewards();
      const reward = rewards[0]!;
      await approve(reward.id, reviewer.id);

      const first = await t.prisma.$transaction((tx) => ledger.postReward(tx, reward.id, reviewer.id));
      const replay = await t.prisma.$transaction((tx) => ledger.postReward(tx, reward.id, reviewer.id));
      expect(first.created).toBe(true);
      expect(replay).toEqual({ transactionId: first.transactionId, created: false });
      expect((await t.prisma.reward.findUniqueOrThrow({ where: { id: reward.id } })).status).toBe('POSTED');

      const reversal = await t.prisma.$transaction((tx) => ledger.reverseReward(tx, reward.id, reviewer.id, 'Customer refund issued'));
      const again = await t.prisma.$transaction((tx) => ledger.reverseReward(tx, reward.id, reviewer.id, 'Customer refund issued'));
      expect(again).toEqual({ transactionId: reversal.transactionId, created: false });
      const r = await t.prisma.reward.findUniqueOrThrow({ where: { id: reward.id } });
      expect(r).toMatchObject({ status: 'REVERSED', reversedById: reviewer.id, reversalReason: 'Customer refund issued' });
      const [bal] = await t.prisma.$queryRaw<Array<{ credits_minor: bigint; debits_minor: bigint }>>`
        SELECT "credits_minor", "debits_minor" FROM "ledger_account_balances" WHERE "user_id" = ${reward.recipientUserId}::uuid`;
      expect(bal).toEqual({ credits_minor: 10_000n, debits_minor: 10_000n });
    });

    it('refuses to post a reward that is not approved, and to reverse one that is not posted', async () => {
      const { reviewer, rewards } = await pendingRewards();
      await expect(t.prisma.$transaction((tx) => ledger.postReward(tx, rewards[0]!.id, reviewer.id))).rejects.toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
      });
      await expect(
        t.prisma.$transaction((tx) => ledger.reverseReward(tx, rewards[0]!.id, reviewer.id, 'reason long enough')),
      ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    });

    it('creates exactly one posting under concurrent attempts', async () => {
      const { reviewer, rewards } = await pendingRewards();
      const reward = rewards[0]!;
      await approve(reward.id, reviewer.id);
      const results = await Promise.all(
        [1, 2, 3].map(() => t.prisma.$transaction((tx) => ledger.postReward(tx, reward.id, reviewer.id))),
      );
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
      expect(await t.prisma.ledgerTransaction.count({ where: { rewardId: reward.id } })).toBe(1);
    });
  });
});
