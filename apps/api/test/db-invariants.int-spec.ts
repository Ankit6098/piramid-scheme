import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mapDbError } from '../src/common/errors/db-error';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase, testPrisma } from './utils/db';
import { createEnrollment, createPolicy, createProgram, createUser } from './utils/factories';
import { ProbeModule } from './utils/probe.module';

/** Awaits a failing DB operation and returns its error mapped by the API's exception mapping. */
async function dbFailure(p: Promise<unknown>) {
  let error: unknown;
  try {
    await p;
  } catch (e) {
    error = e;
  }
  expect(error, 'expected the database to reject the operation').toBeDefined();
  const mapped = mapDbError(error);
  expect(mapped, `unmapped DB error: ${String(error)}`).not.toBeNull();
  return mapped!;
}

async function ledgerAccounts(prisma: PrismaClient, userId: string) {
  const expense = await prisma.ledgerAccount.create({
    data: { type: 'PLATFORM_REWARD_EXPENSE', rewardUnit: 'MONEY', currencyCode: 'INR' },
  });
  const payable = await prisma.ledgerAccount.create({
    data: { type: 'MEMBER_REWARDS_PAYABLE', userId, rewardUnit: 'MONEY', currencyCode: 'INR' },
  });
  return { expense, payable };
}

/** Minimal event → calculation → reward chain (PENDING_APPROVAL). */
async function createReward(prisma: PrismaClient) {
  const sponsor = await createUser(prisma);
  const buyer = await createUser(prisma, { sponsorId: sponsor.id });
  const program = await createProgram(prisma);
  const policy = await createPolicy(prisma, { programId: program.id });
  const event = await prisma.qualifyingEvent.create({
    data: {
      programId: program.id,
      offeringId: program.offeringId,
      type: 'PRODUCT_SALE',
      source: 'ADMIN_MANUAL',
      externalId: `ext-${Date.now()}`,
      subjectUserId: buyer.id,
      amountMinor: 100_000n,
      currencyCode: 'INR',
      occurredAt: new Date(),
      status: 'PROCESSED',
      processedAt: new Date(),
      policyVersionId: policy.id,
    },
  });
  const calc = await prisma.rewardCalculation.create({
    data: {
      eventId: event.id,
      policyVersionId: policy.id,
      outcome: 'REWARDS_CREATED',
      rewardUnit: 'MONEY',
      currencyCode: 'INR',
      budgetMinor: 20_000n,
      totalAllocatedMinor: 10_000n,
      trace: { test: true },
      engineVersion: 'test',
    },
  });
  return prisma.reward.create({
    data: {
      calculationId: calc.id,
      eventId: event.id,
      programId: program.id,
      policyVersionId: policy.id,
      recipientUserId: sponsor.id,
      level: 1,
      amountMinor: 10_000n,
      rewardUnit: 'MONEY',
      currencyCode: 'INR',
    },
  });
}

describe('database invariants (raw SQL constraints & triggers)', () => {
  let prisma: PrismaClient;
  let t: TestApp;

  beforeAll(async () => {
    prisma = testPrisma();
    t = await createTestApp({ imports: [ProbeModule] });
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });
  afterAll(async () => {
    await t?.close();
    await disconnectTestPrisma();
  });

  describe('ledger', () => {
    it('rejects an unbalanced transaction at COMMIT (deferred trigger) → INVARIANT_VIOLATION', async () => {
      const user = await createUser(prisma);
      const { expense, payable } = await ledgerAccounts(prisma, user.id);
      const err = await dbFailure(
        prisma.$transaction(async (tx) => {
          const txn = await tx.ledgerTransaction.create({ data: { type: 'REWARD_POSTING', idempotencyKey: 'unbalanced-1' } });
          await tx.ledgerEntry.create({
            data: { transactionId: txn.id, accountId: expense.id, direction: 'DEBIT', amountMinor: 100n, rewardUnit: 'MONEY', currencyCode: 'INR' },
          });
          await tx.ledgerEntry.create({
            data: { transactionId: txn.id, accountId: payable.id, direction: 'CREDIT', amountMinor: 99n, rewardUnit: 'MONEY', currencyCode: 'INR' },
          });
        }),
      );
      expect(err.code).toBe('INVARIANT_VIOLATION');
      expect(err.httpStatus).toBe(409);
      expect(await prisma.ledgerTransaction.count()).toBe(0);
    });

    it('maps the commit-time failure to HTTP 409 INVARIANT_VIOLATION', async () => {
      const user = await createUser(prisma);
      await ledgerAccounts(prisma, user.id);
      const res = await t.client().post('/api/v1/__probe/unbalanced-ledger').expect(409);
      expect(res.body.error.code).toBe('INVARIANT_VIOLATION');
      expect(res.body.error.details.sqlState).toBe('23514');
    });

    it('accepts a balanced transaction; entries and transactions are immutable', async () => {
      const user = await createUser(prisma);
      const { expense, payable } = await ledgerAccounts(prisma, user.id);
      const txn = await prisma.$transaction(async (tx) => {
        const created = await tx.ledgerTransaction.create({ data: { type: 'REWARD_POSTING', idempotencyKey: 'balanced-1' } });
        await tx.ledgerEntry.createMany({
          data: [
            { transactionId: created.id, accountId: expense.id, direction: 'DEBIT', amountMinor: 500n, rewardUnit: 'MONEY', currencyCode: 'INR' },
            { transactionId: created.id, accountId: payable.id, direction: 'CREDIT', amountMinor: 500n, rewardUnit: 'MONEY', currencyCode: 'INR' },
          ],
        });
        return created;
      });
      const entry = await prisma.ledgerEntry.findFirstOrThrow({ where: { transactionId: txn.id } });

      const upd = await dbFailure(prisma.ledgerEntry.update({ where: { id: entry.id }, data: { amountMinor: 1n } }));
      expect(upd.code).toBe('INVARIANT_VIOLATION');
      expect((upd.details as { sqlState: string }).sqlState).toBe('23001');
      const del = await dbFailure(prisma.ledgerEntry.delete({ where: { id: entry.id } }));
      expect(del.code).toBe('INVARIANT_VIOLATION');
      const txnUpd = await dbFailure(prisma.ledgerTransaction.update({ where: { id: txn.id }, data: { description: 'x' } }));
      expect(txnUpd.code).toBe('INVARIANT_VIOLATION');
      const raw = await dbFailure(prisma.$executeRaw`UPDATE "ledger_entries" SET "amount_minor" = 1 WHERE "id" = ${entry.id}::uuid`);
      expect(raw.code).toBe('INVARIANT_VIOLATION');
    });
  });

  describe('referral attribution', () => {
    it('blocks relationship/path updates without the SET LOCAL flag and allows them with it', async () => {
      const a = await createUser(prisma);
      const b = await createUser(prisma, { sponsorId: a.id });
      const c = await createUser(prisma);
      const rel = await prisma.referralRelationship.findUniqueOrThrow({ where: { childUserId: b.id } });

      const blocked = await dbFailure(
        prisma.referralRelationship.update({ where: { id: rel.id }, data: { sponsorUserId: c.id, source: 'ADMIN_CORRECTION' } }),
      );
      expect(blocked.code).toBe('INVARIANT_VIOLATION');
      const pathBlocked = await dbFailure(
        prisma.referralPath.deleteMany({ where: { descendantId: b.id, depth: { gt: 0 } } }),
      );
      expect(pathBlocked.code).toBe('INVARIANT_VIOLATION');

      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL app.referral_correction = 'on'`;
        await tx.referralRelationship.update({ where: { id: rel.id }, data: { sponsorUserId: c.id, source: 'ADMIN_CORRECTION' } });
        await tx.referralPath.deleteMany({ where: { descendantId: b.id, depth: { gt: 0 } } });
        await tx.$executeRaw`
          INSERT INTO "referral_paths" ("ancestor_id", "descendant_id", "depth")
          SELECT "ancestor_id", ${b.id}::uuid, "depth" + 1 FROM "referral_paths" WHERE "descendant_id" = ${c.id}::uuid`;
      });
      const moved = await prisma.referralRelationship.findUniqueOrThrow({ where: { childUserId: b.id } });
      expect(moved.sponsorUserId).toBe(c.id);
      const paths = await prisma.referralPath.findMany({ where: { descendantId: b.id }, orderBy: { depth: 'asc' } });
      expect(paths.map((p) => [p.ancestorId, p.depth])).toEqual([
        [b.id, 0],
        [c.id, 1],
      ]);

      // SET LOCAL is transaction-scoped: the next statement is guarded again.
      const again = await dbFailure(prisma.referralRelationship.update({ where: { id: rel.id }, data: { sponsorUserId: a.id } }));
      expect(again.code).toBe('INVARIANT_VIOLATION');
    });

    it('rejects self-referral rows', async () => {
      const a = await createUser(prisma);
      const err = await dbFailure(prisma.referralRelationship.create({ data: { childUserId: a.id, sponsorUserId: a.id } }));
      expect(err.code).toBe('INVARIANT_VIOLATION');
      expect((err.details as { constraint?: string }).constraint).toBe('ck_referral_relationships_not_self');
    });
  });

  describe('reward policies', () => {
    it('published policy versions and their rules are immutable', async () => {
      const program = await createProgram(prisma);
      const policy = await createPolicy(prisma, { programId: program.id, status: 'PUBLISHED' });
      const rule = policy.rules[0]!;

      expect((await dbFailure(prisma.rewardRule.update({ where: { id: rule.id }, data: { percentageBps: 4000 } }))).code).toBe(
        'INVARIANT_VIOLATION',
      );
      expect(
        (await dbFailure(prisma.rewardRule.create({ data: { policyVersionId: policy.id, level: 3, calcType: 'PERCENTAGE', percentageBps: 100 } })))
          .code,
      ).toBe('INVARIANT_VIOLATION');
      expect((await dbFailure(prisma.rewardRule.delete({ where: { id: rule.id } }))).code).toBe('INVARIANT_VIOLATION');
      expect((await dbFailure(prisma.rewardPolicyVersion.update({ where: { id: policy.id }, data: { budgetBps: 100 } }))).code).toBe(
        'INVARIANT_VIOLATION',
      );
      // closing the range at a non-past instant is the one allowed change
      await prisma.rewardPolicyVersion.update({ where: { id: policy.id }, data: { effectiveTo: new Date(Date.now() + 60_000) } });
      // drafts stay editable
      const draft = await createPolicy(prisma, { programId: program.id, status: 'DRAFT' });
      await prisma.rewardRule.update({ where: { id: draft.rules[0]!.id }, data: { percentageBps: 1500 } });
    });

    it('rejects overlapping effective ranges of non-draft versions (exclusion constraint)', async () => {
      const program = await createProgram(prisma);
      const now = Date.now();
      await createPolicy(prisma, { programId: program.id, effectiveFrom: new Date(now - 10 * 86_400_000), effectiveTo: null });
      const err = await dbFailure(createPolicy(prisma, { programId: program.id, effectiveFrom: new Date(now + 86_400_000) }));
      expect(err.code).toBe('INVARIANT_VIOLATION');
      expect(err.details).toMatchObject({ sqlState: '23P01', constraint: 'ex_policy_versions_no_overlap' });
      // drafts may overlap freely
      await createPolicy(prisma, { programId: program.id, status: 'DRAFT', effectiveFrom: new Date(now + 86_400_000) });
    });

    it('caps budgetBps at 5000 (50 %)', async () => {
      const program = await createProgram(prisma);
      const err = await dbFailure(createPolicy(prisma, { programId: program.id, status: 'DRAFT', budgetBps: 5001 }));
      expect(err.code).toBe('INVARIANT_VIOLATION');
      expect((err.details as { constraint?: string }).constraint).toBe('ck_policy_versions_budget');
    });
  });

  describe('rewards', () => {
    it('rejects illegal status transitions and allows legal ones', async () => {
      const reward = await createReward(prisma);
      const illegal = await dbFailure(prisma.reward.update({ where: { id: reward.id }, data: { status: 'POSTED', postedAt: new Date(), approvedAt: new Date() } }));
      expect(illegal.code).toBe('INVARIANT_VIOLATION');
      expect((illegal.details as { reason?: string }).reason).toMatch(/Invalid reward status transition/);

      await prisma.reward.update({ where: { id: reward.id }, data: { status: 'APPROVED', approvedAt: new Date() } });
      const back = await dbFailure(prisma.reward.update({ where: { id: reward.id }, data: { status: 'PENDING_APPROVAL' } }));
      expect(back.code).toBe('INVARIANT_VIOLATION');
      const amount = await dbFailure(prisma.reward.update({ where: { id: reward.id }, data: { amountMinor: 1n } }));
      expect(amount.code).toBe('INVARIANT_VIOLATION');
    });
  });

  describe('enrollments', () => {
    it('allows at most one open enrollment per member and program (partial unique index)', async () => {
      const user = await createUser(prisma);
      const program = await createProgram(prisma);
      await createEnrollment(prisma, { userId: user.id, programId: program.id, status: 'ACTIVE' });
      const dup = await dbFailure(createEnrollment(prisma, { userId: user.id, programId: program.id, status: 'PENDING' }));
      expect(dup.code).toBe('CONFLICT');
      expect(dup.httpStatus).toBe(409);

      // closed enrollments do not count
      const other = await createProgram(prisma);
      await createEnrollment(prisma, { userId: user.id, programId: other.id, status: 'CANCELLED' });
      await createEnrollment(prisma, { userId: user.id, programId: other.id, status: 'CANCELLED' });
      await createEnrollment(prisma, { userId: user.id, programId: other.id, status: 'PENDING' });
    });

    it('terminal statuses never change', async () => {
      const user = await createUser(prisma);
      const program = await createProgram(prisma);
      const e = await createEnrollment(prisma, { userId: user.id, programId: program.id, status: 'CANCELLED' });
      const err = await dbFailure(prisma.programEnrollment.update({ where: { id: e.id }, data: { status: 'ACTIVE', effectiveFrom: new Date() } }));
      expect(err.code).toBe('INVARIANT_VIOLATION');
    });
  });

  describe('append-only audit log', () => {
    it('cannot update or delete audit rows', async () => {
      const row = await prisma.auditLog.create({ data: { action: 'test.action', resourceType: 'test', actorRoles: ['SYSTEM'] } });
      expect((await dbFailure(prisma.auditLog.update({ where: { id: row.id }, data: { reason: 'tamper' } }))).code).toBe('INVARIANT_VIOLATION');
      expect((await dbFailure(prisma.auditLog.delete({ where: { id: row.id } }))).code).toBe('INVARIANT_VIOLATION');
    });
  });
});
