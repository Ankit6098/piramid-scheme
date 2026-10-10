import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mapDbError } from '../src/common/errors/db-error';
import { lockReferralTreeExclusive, lockReferralTreeShared, setReferralCorrectionId } from '../src/common/prisma/referral-tree-lock';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase, testDatabaseUrl, testPrisma } from './utils/db';
import {
  createEnrollment,
  createEvent,
  createPolicy,
  createProgram,
  createUser,
  factoryAdmin,
  postRewardForTest,
  processEventForTest,
} from './utils/factories';
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

/** A raw `pg` client on TEST_DATABASE_URL (simple-query protocol: multi-statement scripts allowed). */
async function rawClient(): Promise<Client> {
  const url = new URL(testDatabaseUrl());
  url.search = '';
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  return client;
}

/**
 * Runs a whole `BEGIN; …; COMMIT;` script and returns the error (SQLSTATE + message) it must raise.
 * Always issues a ROLLBACK afterwards so a failure mid-script leaves no open transaction.
 */
async function attack(client: Client, script: string): Promise<{ code: string; message: string }> {
  let error: { code?: string; message?: string } | null = null;
  try {
    await client.query(script);
  } catch (e) {
    error = e as { code?: string; message?: string };
  }
  await client.query('ROLLBACK');
  if (!error) throw new Error('the attack was NOT rejected by the database');
  return { code: String(error.code), message: String(error.message) };
}

/** A small processed sale: sponsor ← buyer, ACTIVE program + published policy, one pending reward. */
async function createRewardChain(prisma: PrismaClient) {
  const sponsor = await createUser(prisma);
  const buyer = await createUser(prisma, { sponsor });
  const program = await createProgram(prisma);
  const policy = await createPolicy(prisma, { programId: program.id });
  const event = await createEvent(prisma, { programId: program.id, subjectUserId: buyer.id, amountMinor: 100_000n });
  const { calculation, rewards } = await processEventForTest(prisma, {
    eventId: event.id,
    policyVersionId: policy.id,
    rewards: [{ recipientUserId: sponsor.id, level: 1, amountMinor: 10_000n }],
  });
  return { sponsor, buyer, program, policy, event, calculation, reward: rewards[0]! };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Invariants through the factories (Prisma)
// ════════════════════════════════════════════════════════════════════════════

describe('database invariants (factories + Prisma)', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = testPrisma();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });
  afterAll(async () => {
    await disconnectTestPrisma();
  });

  describe('referral tree', () => {
    it('factories build a consistent closure table (A > B > C) and a referral code per member', async () => {
      const a = await createUser(prisma);
      const b = await createUser(prisma, { sponsor: a });
      const c = await createUser(prisma, { sponsor: b });
      const paths = await prisma.referralPath.findMany({ where: { descendantId: c.id }, orderBy: { depth: 'asc' } });
      expect(paths.map((p) => [p.ancestorId, p.depth])).toEqual([
        [c.id, 0],
        [b.id, 1],
        [a.id, 2],
      ]);
      const rel = await prisma.referralRelationship.findUniqueOrThrow({ where: { childUserId: c.id } });
      expect(rel).toMatchObject({ sponsorUserId: b.id, referralCodeId: b.referralCodeId, source: 'REGISTRATION' });
      expect(await prisma.referralCode.count({ where: { userId: { in: [a.id, b.id, c.id] }, isActive: true } })).toBe(3);
    });

    it('a sponsor must be ACTIVE and verified', async () => {
      const suspended = await createUser(prisma, { status: 'SUSPENDED' });
      const err = await dbFailure(createUser(prisma, { sponsor: suspended }));
      expect(err.code).toBe('INVARIANT_VIOLATION');
      expect((err.details as { reason: string }).reason).toMatch(/active, verified sponsor/);
    });

    it('relationships and paths are immutable outside a correction', async () => {
      const a = await createUser(prisma);
      const b = await createUser(prisma, { sponsor: a });
      const c = await createUser(prisma);
      const blocked = await dbFailure(prisma.referralRelationship.update({ where: { childUserId: b.id }, data: { sponsorUserId: c.id } }));
      expect(blocked.details).toMatchObject({ sqlState: '23001' });
      const pathBlocked = await dbFailure(prisma.referralPath.deleteMany({ where: { descendantId: b.id, depth: { gt: 0 } } }));
      expect(pathBlocked.code).toBe('INVARIANT_VIOLATION');
      // a leaked correction id without a correction row in this transaction does not help
      const leaked = await dbFailure(
        prisma.$transaction(async (tx) => {
          await lockReferralTreeExclusive(tx);
          await setReferralCorrectionId(tx, '00000000-0000-4000-8000-000000000000');
          await tx.referralRelationship.update({ where: { childUserId: b.id }, data: { sponsorUserId: c.id } });
        }),
      );
      expect(leaked.code).toBe('INVARIANT_VIOLATION');
    });

    // Regression: app_referral_modify_guard() used to read NEW."child_user_id" on referral_paths too
    // (42703). Fixed by migration 20261010120000_fix_referral_modify_guard.
    it('the correction protocol (exclusive lock → correction row → SET LOCAL id) can move a member', async () => {
      const a = await createUser(prisma);
      const b = await createUser(prisma, { sponsor: a });
      const c = await createUser(prisma);
      const admin = await factoryAdmin(prisma);
      await prisma.$transaction(async (tx) => {
        await lockReferralTreeExclusive(tx);
        const correction = await tx.referralCorrection.create({
          data: { childUserId: b.id, previousSponsorId: a.id, newSponsorId: c.id, reason: 'wrong sponsor at signup', performedById: admin.id },
        });
        await setReferralCorrectionId(tx, correction.id);
        await tx.referralRelationship.update({ where: { childUserId: b.id }, data: { sponsorUserId: c.id, source: 'ADMIN_CORRECTION' } });
        await tx.referralPath.deleteMany({ where: { descendantId: b.id, depth: { gt: 0 } } });
        await tx.$executeRaw`
          INSERT INTO "referral_paths" ("ancestor_id", "descendant_id", "depth")
          SELECT "ancestor_id", ${b.id}::uuid, "depth" + 1 FROM "referral_paths" WHERE "descendant_id" = ${c.id}::uuid`;
      });
      const paths = await prisma.referralPath.findMany({ where: { descendantId: b.id }, orderBy: { depth: 'asc' } });
      expect(paths.map((p) => [p.ancestorId, p.depth])).toEqual([
        [b.id, 0],
        [c.id, 1],
      ]);
      // the setting is transaction-scoped: the next statement is guarded again
      const again = await dbFailure(prisma.referralRelationship.update({ where: { childUserId: b.id }, data: { sponsorUserId: a.id } }));
      expect(again.code).toBe('INVARIANT_VIOLATION');
    });

    it('rejects self-referral even inside a valid registration transaction (CHECK)', async () => {
      const err = await dbFailure(
        prisma.$transaction(async (tx) => {
          const u = await tx.user.create({ data: { email: 'self@example.test', fullName: 'Self', status: 'ACTIVE', emailVerifiedAt: new Date() } });
          await lockReferralTreeShared(tx);
          await tx.referralPath.create({ data: { ancestorId: u.id, descendantId: u.id, depth: 0 } });
          const code = await tx.referralCode.create({ data: { userId: u.id, code: 'SELFREF2' } });
          await tx.referralRelationship.create({ data: { childUserId: u.id, sponsorUserId: u.id, referralCodeId: code.id } });
        }),
      );
      expect(err.details).toMatchObject({ sqlState: '23514', constraint: 'ck_referral_relationships_not_self' });
    });
  });

  describe('programs & policies', () => {
    it('programs are created DRAFT and follow the lifecycle', async () => {
      expect((await createProgram(prisma, { status: 'PAUSED' })).status).toBe('PAUSED');
      const archived = await createProgram(prisma, { status: 'ARCHIVED' });
      expect(archived.status).toBe('ARCHIVED');
      const changes = await prisma.programStatusChange.findMany({ where: { programId: archived.id } });
      expect(changes.map((c) => `${c.fromStatus ?? '-'}>${c.toStatus}`).sort()).toEqual(['->DRAFT', 'ACTIVE>COMPLETED', 'COMPLETED>ARCHIVED', 'DRAFT>ACTIVE']);
      const direct = await dbFailure(
        prisma.program.create({
          data: {
            code: 'direct-active',
            name: 'x',
            status: 'ACTIVE',
            offeringId: archived.offeringId,
            startsAt: new Date(),
            enrollmentOpensAt: new Date(),
            rewardUnit: 'MONEY',
            currencyCode: 'INR',
            currencyMinorUnits: 2,
            publishedAt: new Date(),
          },
        }),
      );
      expect(direct.details).toMatchObject({ sqlState: '23001' });
      const back = await dbFailure(prisma.program.update({ where: { id: archived.id }, data: { status: 'DRAFT' } }));
      expect((back.details as { reason: string }).reason).toMatch(/Invalid program status transition/);
    });

    it('published policy versions and their rules are immutable', async () => {
      const program = await createProgram(prisma);
      const policy = await createPolicy(prisma, { programId: program.id, status: 'PUBLISHED' });
      const rule = policy.rules[0]!;
      expect((await dbFailure(prisma.rewardRule.update({ where: { id: rule.id }, data: { percentageBps: 4000 } }))).code).toBe('INVARIANT_VIOLATION');
      expect(
        (await dbFailure(prisma.rewardRule.create({ data: { policyVersionId: policy.id, level: 3, calcType: 'PERCENTAGE', percentageBps: 100 } }))).code,
      ).toBe('INVARIANT_VIOLATION');
      expect((await dbFailure(prisma.rewardRule.delete({ where: { id: rule.id } }))).code).toBe('INVARIANT_VIOLATION');
      expect((await dbFailure(prisma.rewardPolicyVersion.update({ where: { id: policy.id }, data: { budgetBps: 100 } }))).code).toBe('INVARIANT_VIOLATION');
      // closing the range at a non-past instant is the one allowed change
      await prisma.rewardPolicyVersion.update({ where: { id: policy.id }, data: { effectiveTo: new Date(Date.now() + 60_000) } });
      // drafts stay editable
      const draft = await createPolicy(prisma, { programId: program.id, status: 'DRAFT' });
      await prisma.rewardRule.update({ where: { id: draft.rules[0]!.id }, data: { percentageBps: 1500 } });
    });

    it('rejects overlapping effective ranges of non-draft versions (exclusion, at COMMIT); closeCurrent publishes cleanly', async () => {
      const program = await createProgram(prisma);
      await createPolicy(prisma, { programId: program.id });
      const err = await dbFailure(createPolicy(prisma, { programId: program.id, effectiveFrom: new Date(Date.now() + 86_400_000) }));
      expect(err.details).toMatchObject({ sqlState: '23P01', constraint: 'ex_policy_versions_no_overlap' });
      // drafts may overlap freely
      await createPolicy(prisma, { programId: program.id, status: 'DRAFT', effectiveFrom: new Date(Date.now() + 86_400_000) });
      const v2 = await createPolicy(prisma, { programId: program.id, effectiveFrom: new Date(Date.now() + 3_600_000), closeCurrent: true });
      expect(v2.status).toBe('PUBLISHED');
    });

    it('caps budgetBps at 5000 (50 %) and refuses retroactive policies', async () => {
      const program = await createProgram(prisma);
      const cap = await dbFailure(createPolicy(prisma, { programId: program.id, status: 'DRAFT', budgetBps: 5001 }));
      expect((cap.details as { constraint?: string }).constraint).toBe('ck_policy_versions_budget');
      const past = await dbFailure(createPolicy(prisma, { programId: program.id, effectiveFrom: new Date(Date.now() - 86_400_000) }));
      expect((past.details as { reason: string }).reason).toMatch(/in the past/);
    });

    it('auto-approving policies can only be published by a SUPER_ADMIN', async () => {
      const program = await createProgram(prisma);
      const pa = await createUser(prisma, { roles: ['PROGRAM_ADMIN'], programScopes: [program.id] });
      const err = await dbFailure(createPolicy(prisma, { programId: program.id, requiresApproval: false, publishedById: pa.id }));
      expect((err.details as { reason: string }).reason).toMatch(/SUPER_ADMIN/);
      await createPolicy(prisma, { programId: program.id, requiresApproval: false });
    });
  });

  describe('enrollments', () => {
    it('at most one PENDING enrollment per member and program; activated periods never overlap', async () => {
      const user = await createUser(prisma);
      const program = await createProgram(prisma, { options: [{ priceMinor: 50_000n, billingFrequency: 'YEARLY', durationDays: 365 }] });
      await createEnrollment(prisma, { userId: user.id, programId: program.id, status: 'PENDING' });
      const dup = await dbFailure(createEnrollment(prisma, { userId: user.id, programId: program.id, status: 'PENDING' }));
      expect(dup).toMatchObject({ code: 'CONFLICT', httpStatus: 409 });

      const other = await createProgram(prisma);
      await createEnrollment(prisma, { userId: user.id, programId: other.id, status: 'ACTIVE' });
      const overlap = await dbFailure(createEnrollment(prisma, { userId: user.id, programId: other.id, status: 'ACTIVE' }));
      expect(overlap.details).toMatchObject({ sqlState: '23P01', constraint: 'ex_enrollments_no_overlap' });
      // a cancelled-before-start period is empty and does not block
      await createEnrollment(prisma, { userId: user.id, programId: other.id, status: 'CANCELLED', cancelledFrom: 'PENDING' });
    });

    it('paid options need a payment record; payment records and terminal statuses are immutable', async () => {
      const user = await createUser(prisma);
      const program = await createProgram(prisma, { options: [{ priceMinor: 99_900n, billingFrequency: 'MONTHLY', durationDays: 30 }] });
      const pending = await createEnrollment(prisma, { userId: user.id, programId: program.id, status: 'PENDING' });
      const unpaid = await dbFailure(
        prisma.programEnrollment.update({
          where: { id: pending.id },
          data: { status: 'ACTIVE', effectiveFrom: new Date(), effectiveTo: new Date(Date.now() + 30 * 86_400_000), eligibilityStatus: 'ELIGIBLE' },
        }),
      );
      expect((unpaid.details as { constraint?: string }).constraint).toBe('ck_enrollments_paid_activation');

      const paidUser = await createUser(prisma);
      const active = await createEnrollment(prisma, { userId: paidUser.id, programId: program.id });
      expect(active).toMatchObject({ status: 'ACTIVE', paymentAmountMinor: 99_900n, eligibilityStatus: 'ELIGIBLE' });
      expect((await dbFailure(prisma.programEnrollment.update({ where: { id: active.id }, data: { paymentAmountMinor: 1n } }))).code).toBe(
        'INVARIANT_VIOLATION',
      );

      const cancelled = await createEnrollment(prisma, { userId: (await createUser(prisma)).id, programId: program.id, status: 'CANCELLED' });
      expect(cancelled.cancelledAt).not.toBeNull();
      const revive = await dbFailure(prisma.programEnrollment.update({ where: { id: cancelled.id }, data: { status: 'ACTIVE' } }));
      expect(revive.code).toBe('INVARIANT_VIOLATION');
    });

    it('a PAUSED program accepts no enrollments', async () => {
      const program = await createProgram(prisma, { status: 'PAUSED' });
      const err = await dbFailure(createEnrollment(prisma, { userId: (await createUser(prisma)).id, programId: program.id }));
      expect((err.details as { reason: string }).reason).toMatch(/not open for enrollment/);
    });
  });

  describe('sales, rewards and the ledger', () => {
    it('an admin cannot record a sale for their own downline', async () => {
      const program = await createProgram(prisma);
      const admin = await createUser(prisma, { roles: ['PROGRAM_ADMIN'], programScopes: [program.id] });
      const downline = await createUser(prisma, { sponsor: admin });
      const err = await dbFailure(createEvent(prisma, { programId: program.id, subjectUserId: downline.id, recordedById: admin.id }));
      expect((err.details as { reason: string }).reason).toMatch(/own downline/);
    });

    it('rewards follow the state machine; recorded facts are immutable', async () => {
      const { reward } = await createRewardChain(prisma);
      const illegal = await dbFailure(prisma.reward.update({ where: { id: reward.id }, data: { status: 'POSTED', postedAt: new Date(), approvedAt: new Date() } }));
      expect((illegal.details as { reason?: string }).reason).toMatch(/Invalid reward status transition/);
      const reviewer = await createUser(prisma, { roles: ['FINANCE_REVIEWER'] });
      const noApprover = await dbFailure(prisma.reward.update({ where: { id: reward.id }, data: { status: 'APPROVED', approvedAt: new Date() } }));
      expect((noApprover.details as { reason?: string }).reason).toMatch(/name the approver/);
      await prisma.reward.update({ where: { id: reward.id }, data: { status: 'APPROVED', approvedAt: new Date(), approvedById: reviewer.id } });
      expect((await dbFailure(prisma.reward.update({ where: { id: reward.id }, data: { status: 'PENDING_APPROVAL' } }))).code).toBe('INVARIANT_VIOLATION');
      expect((await dbFailure(prisma.reward.update({ where: { id: reward.id }, data: { amountMinor: 1n } }))).code).toBe('INVARIANT_VIOLATION');
    });

    it('POSTED requires exactly one balanced posting; entries are append-only', async () => {
      const { reward } = await createRewardChain(prisma);
      const reviewer = await createUser(prisma, { roles: ['FINANCE_REVIEWER'] });
      // POSTED without a ledger transaction fails at COMMIT
      const unposted = await dbFailure(
        prisma.$transaction(async (tx) => {
          await tx.reward.update({ where: { id: reward.id }, data: { status: 'APPROVED', approvedById: reviewer.id, approvedAt: new Date() } });
          await tx.reward.update({ where: { id: reward.id }, data: { status: 'POSTED', postedAt: new Date() } });
        }),
      );
      expect((unposted.details as { reason?: string }).reason).toMatch(/does not match its ledger postings/);

      const { transactionId, expenseAccountId } = await postRewardForTest(prisma, reward.id, reviewer.id);
      expect((await prisma.reward.findUniqueOrThrow({ where: { id: reward.id } })).status).toBe('POSTED');
      const entry = await prisma.ledgerEntry.findFirstOrThrow({ where: { transactionId } });
      const upd = await dbFailure(prisma.ledgerEntry.update({ where: { id: entry.id }, data: { amountMinor: 1n } }));
      expect(upd.details).toMatchObject({ sqlState: '23001' });
      expect((await dbFailure(prisma.ledgerEntry.delete({ where: { id: entry.id } }))).code).toBe('INVARIANT_VIOLATION');
      // appending a balanced pair to an existing posting fails at COMMIT (header mismatch)
      const appended = await dbFailure(
        prisma.ledgerEntry.createMany({
          data: [
            { transactionId, accountId: expenseAccountId, direction: 'DEBIT', amountMinor: 5n, rewardUnit: 'MONEY', currencyCode: 'INR' },
            { transactionId, accountId: expenseAccountId, direction: 'CREDIT', amountMinor: 5n, rewardUnit: 'MONEY', currencyCode: 'INR' },
          ],
        }),
      );
      expect(appended.details).toMatchObject({ sqlState: '23514' });
    });

    it('the person who recorded a sale cannot approve its rewards', async () => {
      const { reward } = await createRewardChain(prisma);
      const recorder = await factoryAdmin(prisma);
      const err = await dbFailure(prisma.reward.update({ where: { id: reward.id }, data: { status: 'APPROVED', approvedById: recorder.id, approvedAt: new Date() } }));
      expect((err.details as { reason?: string }).reason).toMatch(/recorded the sale/);
    });
  });

  it('audit rows are append-only', async () => {
    const row = await prisma.auditLog.create({ data: { action: 'test.action', resourceType: 'test', actorRoles: ['SYSTEM'] } });
    expect((await dbFailure(prisma.auditLog.update({ where: { id: row.id }, data: { reason: 'tamper' } }))).code).toBe('INVARIANT_VIOLATION');
    expect((await dbFailure(prisma.auditLog.delete({ where: { id: row.id } }))).code).toBe('INVARIANT_VIOLATION');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Raw-SQL end-to-end happy path and attack scenarios (ported from smoke.sql / attacks.sql)
// ════════════════════════════════════════════════════════════════════════════

const ID = {
  A: '00000000-0000-0000-0000-00000000000a', // root member
  B: '00000000-0000-0000-0000-00000000000b', // child of A
  C: '00000000-0000-0000-0000-00000000000c', // child of B
  AD: '00000000-0000-0000-0000-0000000000ad', // SUPER_ADMIN (records the sale)
  F1: '00000000-0000-0000-0000-0000000000f1', // FINANCE_REVIEWER
  CODE_A: '00000000-0000-0000-0000-0000000000ca',
  CODE_B: '00000000-0000-0000-0000-0000000000cb',
  PRG: '00000000-0000-0000-0000-0000000000a1',
  OFF: '00000000-0000-0000-0000-0000000000e1',
  OPT: '00000000-0000-0000-0000-0000000000b1',
  POL: '00000000-0000-0000-0000-0000000000d1',
  EVT: '00000000-0000-0000-0000-0000000000e9',
  CALC: '00000000-0000-0000-0000-0000000000c1',
  R1: '00000000-0000-0000-0000-000000000091', // B, level 1
  R2: '00000000-0000-0000-0000-000000000092', // A, level 2
  ACC_EXP: '00000000-0000-0000-0000-0000000000a7',
  ACC_B: '00000000-0000-0000-0000-0000000000a8',
  T1: '00000000-0000-0000-0000-000000000071',
  T2: '00000000-0000-0000-0000-000000000072',
} as const;

const CHECKPOINT = 'SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;';

/** smoke.sql up to "approve + post R1" (= fixture.sql), without BEGIN/COMMIT. Roles/settings come from the seed. */
const FIXTURE_SQL = `
SELECT pg_advisory_xact_lock_shared(7301,1);
INSERT INTO users (id,full_name,email,status,email_verified_at,updated_at) VALUES
 ('${ID.A}','Anita A','anita@x.io','ACTIVE',now(),now()),
 ('${ID.B}','Rahul R','rahul@x.io','ACTIVE',now(),now()),
 ('${ID.C}','Priya P','priya@x.io','ACTIVE',now(),now()),
 ('${ID.AD}','Admin','admin@x.io','ACTIVE',now(),now()),
 ('${ID.F1}','Fin','fin@x.io','ACTIVE',now(),now());
INSERT INTO user_roles (user_id, role_id) SELECT '${ID.AD}', id FROM roles WHERE key='SUPER_ADMIN';
INSERT INTO user_roles (user_id, role_id) SELECT '${ID.F1}', id FROM roles WHERE key='FINANCE_REVIEWER';
INSERT INTO referral_paths VALUES ('${ID.A}','${ID.A}',0),('${ID.AD}','${ID.AD}',0),('${ID.F1}','${ID.F1}',0);
INSERT INTO referral_codes (id,user_id,code) VALUES ('${ID.CODE_A}','${ID.A}','ANITA234'),('${ID.CODE_B}','${ID.B}','RAHUL234');
INSERT INTO referral_paths VALUES ('${ID.B}','${ID.B}',0);
INSERT INTO referral_relationships (id,child_user_id,sponsor_user_id,referral_code_id,updated_at) VALUES (gen_random_uuid(),'${ID.B}','${ID.A}','${ID.CODE_A}',now());
INSERT INTO referral_paths VALUES ('${ID.A}','${ID.B}',1);
INSERT INTO referral_paths VALUES ('${ID.C}','${ID.C}',0);
INSERT INTO referral_relationships (id,child_user_id,sponsor_user_id,referral_code_id,updated_at) VALUES (gen_random_uuid(),'${ID.C}','${ID.B}','${ID.CODE_B}',now());
INSERT INTO referral_paths SELECT ancestor_id,'${ID.C}',depth+1 FROM referral_paths WHERE descendant_id='${ID.B}';
${CHECKPOINT}

INSERT INTO offerings (id,name,kind,status,approved_by_id,approved_at,updated_at) VALUES ('${ID.OFF}','Widget','PRODUCT','ACTIVE','${ID.AD}',now(),now());
INSERT INTO programs (id,code,name,offering_id,starts_at,enrollment_opens_at,reward_unit,currency_code,currency_minor_units,updated_at)
 VALUES ('${ID.PRG}','p1','P1','${ID.OFF}',now()-interval '1 day',now()-interval '1 day','MONEY','INR',2,now());
INSERT INTO program_options (id,program_id,name,price_minor,currency_code,billing_frequency,duration_days,updated_at) VALUES ('${ID.OPT}','${ID.PRG}','Monthly',200000,'INR','MONTHLY',30,now());
UPDATE programs SET status='ACTIVE', published_at=now(), updated_by_id='${ID.AD}' WHERE id='${ID.PRG}';

INSERT INTO program_enrollments (id,user_id,program_id,option_id,option_snapshot,terms_version,status,updated_at)
 SELECT gen_random_uuid(), u, '${ID.PRG}', '${ID.OPT}', '{"priceMinor":"200000"}', '1.0', 'PENDING', now()
 FROM unnest(ARRAY['${ID.A}'::uuid, '${ID.B}'::uuid]) u;
UPDATE program_enrollments SET status='ACTIVE', eligibility_status='ELIGIBLE', effective_from=now(), effective_to=now()+interval '30 days',
  payment_reference='PAY-'||right(user_id::text,2), payment_amount_minor=200000, payment_recorded_at=now(), payment_recorded_by_id='${ID.AD}';

INSERT INTO reward_policy_versions (id,program_id,version,name,trigger_event_types,max_depth,budget_bps,effective_from,updated_at)
 VALUES ('${ID.POL}','${ID.PRG}',1,'v1','{PRODUCT_SALE}',3,2000,now(),now());
INSERT INTO reward_rules (id,policy_version_id,level,calc_type,percentage_bps) VALUES (gen_random_uuid(),'${ID.POL}',1,'PERCENTAGE',1000),(gen_random_uuid(),'${ID.POL}',2,'PERCENTAGE',500);
UPDATE reward_policy_versions SET status='PUBLISHED', published_at=now(), published_by_id='${ID.AD}' WHERE id='${ID.POL}';

INSERT INTO qualifying_events (id,program_id,offering_id,type,source,external_id,request_hash,customer_reference,subject_user_id,amount_minor,currency_code,occurred_at,recorded_by_id,updated_at)
 VALUES ('${ID.EVT}','${ID.PRG}','${ID.OFF}','PRODUCT_SALE','ADMIN_MANUAL','ORD-1',repeat('a',64),'CUST-1','${ID.C}',100000,'INR',clock_timestamp(),'${ID.AD}',now());
UPDATE qualifying_events SET policy_version_id='${ID.POL}' WHERE id='${ID.EVT}';
INSERT INTO reward_calculations (id,event_id,policy_version_id,outcome,reward_unit,currency_code,currency_minor_units,points_per_currency_unit,base_minor,budget_bps,budget_minor,total_allocated_minor,trace,engine_version)
 VALUES ('${ID.CALC}','${ID.EVT}','${ID.POL}','REWARDS_CREATED','MONEY','INR',2,1,100000,2000,20000,15000,'{}','1.0.0');
INSERT INTO rewards (id,calculation_id,event_id,program_id,policy_version_id,recipient_user_id,level,amount_minor,reward_unit,currency_code,updated_at) VALUES
 ('${ID.R1}','${ID.CALC}','${ID.EVT}','${ID.PRG}','${ID.POL}','${ID.B}',1,10000,'MONEY','INR',now()),
 ('${ID.R2}','${ID.CALC}','${ID.EVT}','${ID.PRG}','${ID.POL}','${ID.A}',2,5000,'MONEY','INR',now());
UPDATE qualifying_events SET status='PROCESSED', processed_at=now() WHERE id='${ID.EVT}';
${CHECKPOINT}

UPDATE rewards SET status='APPROVED', approved_by_id='${ID.F1}', approved_at=now() WHERE id='${ID.R1}';
INSERT INTO ledger_accounts (id,type,user_id,reward_unit,currency_code) VALUES ('${ID.ACC_EXP}','PLATFORM_REWARD_EXPENSE',NULL,'MONEY','INR'),('${ID.ACC_B}','MEMBER_REWARDS_PAYABLE','${ID.B}','MONEY','INR');
INSERT INTO ledger_transactions (id,type,idempotency_key,reward_id,entry_count,debit_total_minor) VALUES ('${ID.T1}','REWARD_POSTING','reward-posting:${ID.R1}','${ID.R1}',2,10000);
INSERT INTO ledger_entries (id,transaction_id,account_id,direction,amount_minor,reward_unit,currency_code) VALUES
 (gen_random_uuid(),'${ID.T1}','${ID.ACC_EXP}','DEBIT',10000,'MONEY','INR'),(gen_random_uuid(),'${ID.T1}','${ID.ACC_B}','CREDIT',10000,'MONEY','INR');
UPDATE rewards SET status='POSTED', posted_at=now() WHERE id='${ID.R1}';
${CHECKPOINT}
`;

/** The rest of smoke.sql: reverse the event (R1 POSTED → REVERSED with a mirror posting, R2 → REJECTED). */
const REVERSAL_SQL = `
UPDATE qualifying_events SET status='REVERSED', reversed_at=now(), reversal_reason='refund' WHERE id='${ID.EVT}';
INSERT INTO ledger_transactions (id,type,idempotency_key,reward_id,reverses_transaction_id,entry_count,debit_total_minor) VALUES ('${ID.T2}','REWARD_REVERSAL','reward-reversal:${ID.R1}','${ID.R1}','${ID.T1}',2,10000);
INSERT INTO ledger_entries (id,transaction_id,account_id,direction,amount_minor,reward_unit,currency_code) VALUES
 (gen_random_uuid(),'${ID.T2}','${ID.ACC_EXP}','CREDIT',10000,'MONEY','INR'),(gen_random_uuid(),'${ID.T2}','${ID.ACC_B}','DEBIT',10000,'MONEY','INR');
UPDATE rewards SET status='REVERSED', reversed_at=now(), reversal_reason='event refunded', reversed_by_id='${ID.F1}' WHERE id='${ID.R1}';
UPDATE rewards SET status='REJECTED', rejected_at=now(), rejection_reason='event refunded', rejected_by_id='${ID.F1}' WHERE id='${ID.R2}';
${CHECKPOINT}
`;

describe('raw SQL happy path (smoke.sql)', () => {
  let client: Client;

  beforeAll(async () => {
    await resetDatabase();
    client = await rawClient();
  });
  afterAll(async () => {
    await client?.query('ROLLBACK').catch(() => undefined);
    await client?.end();
    await disconnectTestPrisma();
  });

  it('registration chain → publish → enroll → policy → sale → calculation → approve + post → event reversal', async () => {
    await client.query('BEGIN');
    try {
      await client.query(FIXTURE_SQL);
      const statusChanges = await client.query(`SELECT to_status FROM program_status_changes WHERE program_id = '${ID.PRG}' ORDER BY from_status NULLS FIRST`);
      expect(statusChanges.rows.map((r: { to_status: string }) => r.to_status)).toEqual(['DRAFT', 'ACTIVE']);
      await client.query(REVERSAL_SQL);
      const balances = await client.query(
        `SELECT type, user_id IS NOT NULL AS member, credits_minor::text AS credits, debits_minor::text AS debits FROM ledger_account_balances ORDER BY type`,
      );
      expect(balances.rows).toEqual([
        { type: 'PLATFORM_REWARD_EXPENSE', member: false, credits: '10000', debits: '10000' },
        { type: 'MEMBER_REWARDS_PAYABLE', member: true, credits: '10000', debits: '10000' },
      ]);
      const rewards = await client.query(`SELECT id, status FROM rewards ORDER BY level`);
      expect(rewards.rows).toEqual([
        { id: ID.R1, status: 'REVERSED' },
        { id: ID.R2, status: 'REJECTED' },
      ]);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});

interface AttackCase {
  name: string;
  sql: string;
  sqlState: '23001' | '23514' | '23505' | '23P01';
  message: RegExp;
}

const tx = (body: string) => `BEGIN; ${body}; COMMIT;`;
const EVENT_COLS = 'id,program_id,offering_id,type,source,external_id,request_hash,customer_reference,subject_user_id,amount_minor,currency_code,occurred_at';

const ATTACKS: AttackCase[] = [
  {
    name: '01 phantom ancestor: add AD as an ancestor of C',
    sql: tx(`SELECT pg_advisory_xact_lock_shared(7301,1); INSERT INTO referral_paths VALUES ('${ID.AD}','${ID.C}',3)`),
    sqlState: '23001',
    message: /Closure rows are only written by the registration/,
  },
  {
    name: '02 late attribution: give root A a sponsor',
    sql: tx(
      `SELECT pg_advisory_xact_lock_shared(7301,1); INSERT INTO referral_relationships (id,child_user_id,sponsor_user_id,referral_code_id,updated_at) VALUES (gen_random_uuid(),'${ID.A}','${ID.AD}','${ID.CODE_A}',now())`,
    ),
    sqlState: '23001',
    message: /only written by the registration that creates the member/,
  },
  {
    name: '03 rewrite a sponsor with a leaked correction id but no correction row',
    sql: tx(
      `SELECT pg_advisory_xact_lock(7301,1); SET LOCAL app.referral_correction_id = '00000000-0000-0000-0000-000000000000'; UPDATE referral_relationships SET sponsor_user_id='${ID.AD}' WHERE child_user_id='${ID.C}'`,
    ),
    sqlState: '23001',
    message: /immutable outside the audited correction workflow/,
  },
  {
    name: '04 correction creating a cycle (A under C)',
    sql: tx(
      `SELECT pg_advisory_xact_lock(7301,1); INSERT INTO referral_corrections (id,child_user_id,previous_sponsor_id,new_sponsor_id,reason,performed_by_id) VALUES ('00000000-0000-0000-0000-0000000000cc','${ID.A}',NULL,'${ID.C}','fixing a mistake here','${ID.AD}')`,
    ),
    sqlState: '23001',
    message: /Referral cycle/,
  },
  {
    name: '05 calculation budget above the policy budget / 50 % of the sale',
    sql: tx(`INSERT INTO qualifying_events (${EVENT_COLS},recorded_by_id,updated_at)
       VALUES ('00000000-0000-0000-0000-0000000000ea','${ID.PRG}','${ID.OFF}','PRODUCT_SALE','ADMIN_MANUAL','ORD-2',repeat('b',64),'CUST-2','${ID.C}',10000,'INR',clock_timestamp(),'${ID.AD}',now());
     UPDATE qualifying_events SET policy_version_id='${ID.POL}' WHERE id='00000000-0000-0000-0000-0000000000ea';
     INSERT INTO reward_calculations (id,event_id,policy_version_id,outcome,reward_unit,currency_code,currency_minor_units,points_per_currency_unit,base_minor,budget_bps,budget_minor,total_allocated_minor,trace,engine_version)
       VALUES (gen_random_uuid(),'00000000-0000-0000-0000-0000000000ea','${ID.POL}','REWARDS_CREATED','MONEY','INR',2,1,10000,2000,9000,9000,'{}','1')`),
    sqlState: '23514',
    message: /ck_calculations_budget_cap/,
  },
  {
    name: '06 extra reward appended to an existing calculation',
    sql: tx(
      `INSERT INTO rewards (id,calculation_id,event_id,program_id,policy_version_id,recipient_user_id,level,amount_minor,reward_unit,currency_code,updated_at) VALUES (gen_random_uuid(),'${ID.CALC}','${ID.EVT}','${ID.PRG}','${ID.POL}','${ID.A}',3,999900,'MONEY','INR',now())`,
    ),
    sqlState: '23001',
    message: /not an upline of the subject at level 3/,
  },
  {
    name: '07 reward inserted directly as POSTED',
    sql: tx(
      `INSERT INTO rewards (id,calculation_id,event_id,program_id,policy_version_id,recipient_user_id,level,amount_minor,reward_unit,currency_code,status,approved_at,posted_at,updated_at) VALUES (gen_random_uuid(),'${ID.CALC}','${ID.EVT}','${ID.PRG}','${ID.POL}','${ID.A}',3,1,'MONEY','INR','POSTED',now(),now(),now())`,
    ),
    sqlState: '23001',
    message: /Rewards are created PENDING_APPROVAL/,
  },
  {
    name: '08 recipient approves their own reward',
    sql: tx(`UPDATE rewards SET status='APPROVED', approved_by_id='${ID.A}', approved_at=now() WHERE id='${ID.R2}'`),
    sqlState: '23514',
    message: /ck_rewards_sod/,
  },
  {
    name: '09 the recorder of the sale approves its reward',
    sql: tx(`UPDATE rewards SET status='APPROVED', approved_by_id='${ID.AD}', approved_at=now() WHERE id='${ID.R2}'`),
    sqlState: '23001',
    message: /recorded the sale cannot approve/,
  },
  {
    name: '10 balanced entries appended to an existing posting',
    sql: tx(`INSERT INTO ledger_entries (id,transaction_id,account_id,direction,amount_minor,reward_unit,currency_code) VALUES
       (gen_random_uuid(),'${ID.T1}','${ID.ACC_EXP}','DEBIT',999900,'MONEY','INR'),(gen_random_uuid(),'${ID.T1}','${ID.ACC_B}','CREDIT',999900,'MONEY','INR')`),
    sqlState: '23514',
    message: /does not match its header/,
  },
  {
    name: '11 second posting for the same reward',
    sql: tx(
      `INSERT INTO ledger_transactions (id,type,idempotency_key,reward_id,entry_count,debit_total_minor) VALUES (gen_random_uuid(),'REWARD_POSTING','reward-posting:${ID.R1}:retry','${ID.R1}',2,10000)`,
    ),
    sqlState: '23514',
    message: /ck_ledger_txn_key/,
  },
  {
    name: '12 posting a reward that is still pending',
    sql: tx(`INSERT INTO ledger_accounts (id,type,user_id,reward_unit,currency_code) VALUES ('00000000-0000-0000-0000-0000000000a9','MEMBER_REWARDS_PAYABLE','${ID.A}','MONEY','INR');
     INSERT INTO ledger_transactions (id,type,idempotency_key,reward_id,entry_count,debit_total_minor) VALUES ('00000000-0000-0000-0000-000000000073','REWARD_POSTING','reward-posting:${ID.R2}','${ID.R2}',2,5000);
     INSERT INTO ledger_entries (id,transaction_id,account_id,direction,amount_minor,reward_unit,currency_code) VALUES
       (gen_random_uuid(),'00000000-0000-0000-0000-000000000073','${ID.ACC_EXP}','DEBIT',5000,'MONEY','INR'),(gen_random_uuid(),'00000000-0000-0000-0000-000000000073','00000000-0000-0000-0000-0000000000a9','CREDIT',5000,'MONEY','INR')`),
    sqlState: '23001',
    message: /status PENDING_APPROVAL does not match its ledger postings/,
  },
  {
    name: '13 reverse the event but leave the POSTED reward live',
    sql: tx(`UPDATE rewards SET status='REJECTED', rejected_at=now(), rejection_reason='x', rejected_by_id='${ID.F1}' WHERE id='${ID.R2}';
     UPDATE qualifying_events SET status='REVERSED', reversed_at=now(), reversal_reason='refund' WHERE id='${ID.EVT}'`),
    sqlState: '23001',
    message: /reversed but still has live rewards/,
  },
  {
    name: '14 an admin records a sale for themselves',
    sql: tx(`INSERT INTO qualifying_events (${EVENT_COLS},recorded_by_id,updated_at)
       VALUES (gen_random_uuid(),'${ID.PRG}','${ID.OFF}','PRODUCT_SALE','ADMIN_MANUAL','ORD-3',repeat('c',64),'CUST-3','${ID.AD}',10000,'INR',clock_timestamp(),'${ID.AD}',now())`),
    sqlState: '23001',
    message: /cannot record sales for themselves or their own downline/,
  },
  {
    name: "15 a member's own plan payment recorded as a sale",
    sql: tx(`INSERT INTO qualifying_events (${EVENT_COLS},recorded_by_id,updated_at)
       VALUES (gen_random_uuid(),'${ID.PRG}','${ID.OFF}','SUBSCRIPTION_RENEWAL','ADMIN_MANUAL','ORD-4',repeat('d',64),'CUST-4','${ID.B}',200000,'INR',clock_timestamp(),'${ID.AD}',now())`),
    sqlState: '23001',
    message: /own plan payment/,
  },
  {
    name: '16 the same sale id recorded twice (via another channel)',
    sql: tx(`INSERT INTO api_clients (id,name,program_id,key_prefix,key_hash) VALUES ('00000000-0000-0000-0000-0000000000ac','shop','${ID.PRG}','abc',repeat('e',64));
     INSERT INTO qualifying_events (${EVENT_COLS},api_client_id,updated_at)
       VALUES (gen_random_uuid(),'${ID.PRG}','${ID.OFF}','PRODUCT_SALE','API','ORD-1',repeat('a',64),'CUST-1','${ID.C}',100000,'INR',clock_timestamp(),'00000000-0000-0000-0000-0000000000ac',now())`),
    sqlState: '23505',
    message: /uq_events_sale_revision/,
  },
  {
    name: '17 edit the rules of the published policy',
    sql: tx(`UPDATE reward_rules SET percentage_bps=5000 WHERE policy_version_id='${ID.POL}' AND level=1`),
    sqlState: '23001',
    message: /Rules of published policy version .* are immutable/,
  },
  {
    name: '18 enable payouts',
    sql: tx(`UPDATE platform_settings SET payouts_enabled=true`),
    sqlState: '23514',
    message: /ck_platform_settings_no_payouts/,
  },
  {
    name: '19 demote the last SUPER_ADMIN',
    sql: tx(`DELETE FROM user_roles WHERE user_id='${ID.AD}'`),
    sqlState: '23001',
    message: /At least one ACTIVE SUPER_ADMIN must remain/,
  },
  {
    name: "20 extend an enrollment's coverage",
    sql: tx(`UPDATE program_enrollments SET effective_to=now()+interval '3000 days' WHERE user_id='${ID.B}'`),
    sqlState: '23001',
    message: /may only be shortened by a cancellation/,
  },
  {
    name: '21 program jumps ACTIVE → SCHEDULED',
    sql: tx(`UPDATE programs SET status='SCHEDULED' WHERE id='${ID.PRG}'`),
    sqlState: '23001',
    message: /Invalid program status transition ACTIVE -> SCHEDULED/,
  },
  {
    name: '22 audit entry carrying a password hash',
    sql: tx(`INSERT INTO audit_logs (id,action,resource_type,after) VALUES (gen_random_uuid(),'user.update','user','{"passwordHash":"x"}')`),
    sqlState: '23514',
    message: /ck_audit_logs_no_secrets/,
  },
  {
    name: '23 outbox message carrying a plaintext OTP',
    sql: tx(`INSERT INTO outbox_messages (id,topic,payload) VALUES (gen_random_uuid(),'email.send','{"to":"a@b.c","data":{"code":"123456"}}')`),
    sqlState: '23514',
    message: /ck_outbox_no_plain_otp/,
  },
  {
    name: '24 auto-approving policy published by a non-SUPER_ADMIN (finance)',
    sql: tx(`INSERT INTO reward_policy_versions (id,program_id,version,name,trigger_event_types,max_depth,budget_bps,requires_approval,effective_from,updated_at)
       VALUES ('00000000-0000-0000-0000-0000000000d2','${ID.PRG}',2,'v2','{PRODUCT_SALE}',3,2000,false,now()+interval '1 day',now());
     INSERT INTO reward_rules (id,policy_version_id,level,calc_type,percentage_bps) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-0000000000d2',1,'PERCENTAGE',1000);
     UPDATE reward_policy_versions SET status='PUBLISHED', published_at=now(), published_by_id='${ID.F1}' WHERE id='00000000-0000-0000-0000-0000000000d2'`),
    sqlState: '23001',
    message: /Only a SUPER_ADMIN can publish a policy that skips reward approval/,
  },
  {
    name: '25 two open OTP challenges for the same address',
    sql: tx(`INSERT INTO email_challenges (id,email,purpose,code_hash,expires_at) VALUES
       (gen_random_uuid(),'x@y.z','PASSWORD_RESET',repeat('1',64),now()+interval '10 min'),(gen_random_uuid(),'x@y.z','PASSWORD_RESET',repeat('2',64),now()+interval '10 min')`),
    sqlState: '23505',
    message: /uq_email_challenges_one_open/,
  },
  {
    name: '26 retroactive policy publication',
    sql: tx(`INSERT INTO reward_policy_versions (id,program_id,version,name,trigger_event_types,max_depth,budget_bps,effective_from,updated_at)
       VALUES ('00000000-0000-0000-0000-0000000000d3','${ID.PRG}',3,'v3','{PRODUCT_SALE}',3,2000,now()-interval '30 days',now());
     INSERT INTO reward_rules (id,policy_version_id,level,calc_type,percentage_bps) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-0000000000d3',1,'PERCENTAGE',1000);
     UPDATE reward_policy_versions SET status='PUBLISHED', published_at=now(), published_by_id='${ID.AD}' WHERE id='00000000-0000-0000-0000-0000000000d3'`),
    sqlState: '23001',
    message: /Policies cannot take effect in the past/,
  },
  // Extra exclusion-constraint cases (23P01, checked at COMMIT / statement end).
  {
    name: '27 second published policy overlapping the open-ended v1',
    sql: tx(`INSERT INTO reward_policy_versions (id,program_id,version,name,trigger_event_types,max_depth,budget_bps,effective_from,updated_at)
       VALUES ('00000000-0000-0000-0000-0000000000d4','${ID.PRG}',4,'v4','{PRODUCT_SALE}',3,2000,now()+interval '1 hour',now());
     INSERT INTO reward_rules (id,policy_version_id,level,calc_type,percentage_bps) VALUES (gen_random_uuid(),'00000000-0000-0000-0000-0000000000d4',1,'PERCENTAGE',1000);
     UPDATE reward_policy_versions SET status='PUBLISHED', published_at=now(), published_by_id='${ID.AD}' WHERE id='00000000-0000-0000-0000-0000000000d4'`),
    sqlState: '23P01',
    message: /ex_policy_versions_no_overlap/,
  },
  {
    name: '28 a second activated enrollment overlapping the current coverage',
    sql: tx(`INSERT INTO program_enrollments (id,user_id,program_id,option_id,option_snapshot,terms_version,status,eligibility_status,effective_from,effective_to,payment_reference,payment_amount_minor,payment_recorded_at,updated_at)
       VALUES (gen_random_uuid(),'${ID.A}','${ID.PRG}','${ID.OPT}','{"priceMinor":"200000"}','1.0','ACTIVE','ELIGIBLE',now(),now()+interval '30 days','PAY-dup',200000,now(),now())`),
    sqlState: '23P01',
    message: /ex_enrollments_no_overlap/,
  },
];

describe('raw SQL attack scenarios (attacks.sql) — each must be rejected', () => {
  let client: Client;

  beforeAll(async () => {
    await resetDatabase();
    client = await rawClient();
    await client.query(`BEGIN; ${FIXTURE_SQL} COMMIT;`);
  });
  afterAll(async () => {
    await client?.end();
    await disconnectTestPrisma();
  });

  it('the committed fixture is the expected state', async () => {
    const r = await client.query(`SELECT id, status FROM rewards ORDER BY level`);
    expect(r.rows).toEqual([
      { id: ID.R1, status: 'POSTED' },
      { id: ID.R2, status: 'PENDING_APPROVAL' },
    ]);
  });

  it.each(ATTACKS.map((a) => [a.name, a] as const))('ATTACK %s', async (_name, a) => {
    const err = await attack(client, a.sql);
    expect(err.code).toBe(a.sqlState);
    expect(err.message).toMatch(a.message);
    // every rejected attack maps to an HTTP 409 in the API
    const mapped = mapDbError({ code: err.code, message: err.message, severity: 'ERROR' });
    expect(mapped?.httpStatus).toBe(409);
    expect(mapped?.code).toBe(a.sqlState === '23505' ? 'CONFLICT' : 'INVARIANT_VIOLATION');
  });

  it('the fixture is untouched after all attacks', async () => {
    const r = await client.query(
      `SELECT (SELECT count(*) FROM rewards)::int AS rewards, (SELECT count(*) FROM ledger_entries)::int AS entries,
              (SELECT count(*) FROM referral_paths)::int AS paths, (SELECT status FROM qualifying_events WHERE id = '${ID.EVT}') AS event`,
    );
    expect(r.rows[0]).toEqual({ rewards: 2, entries: 2, paths: 8, event: 'PROCESSED' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. End-to-end mapping of trigger errors through the HTTP exception filter
// ════════════════════════════════════════════════════════════════════════════

describe('exception filter maps trigger errors to 409 INVARIANT_VIOLATION', () => {
  let t: TestApp;

  beforeAll(async () => {
    await resetDatabase();
    t = await createTestApp({ imports: [ProbeModule] });
  });
  afterAll(async () => {
    await t?.close();
    await disconnectTestPrisma();
  });

  it('restrict_violation raised immediately by a trigger (23001)', async () => {
    const res = await t.client().post('/api/v1/__probe/invariant/immediate').expect(409);
    expect(res.body.error).toMatchObject({
      code: 'INVARIANT_VIOLATION',
      details: { sqlState: '23001', reason: 'Currency definitions are immutable' },
    });
    expect(res.body.error.requestId).toBeTruthy();
  });

  it('check_violation (23514) with the constraint name', async () => {
    const res = await t.client().post('/api/v1/__probe/invariant/check').expect(409);
    expect(res.body.error).toMatchObject({ code: 'INVARIANT_VIOLATION', details: { sqlState: '23514', constraint: 'ck_outbox_no_plain_otp' } });
  });

  it('deferred constraint trigger failing at COMMIT (23001)', async () => {
    await createUser(t.prisma, { roles: ['SUPER_ADMIN'] });
    const res = await t.client().post('/api/v1/__probe/invariant/deferred').expect(409);
    expect(res.body.error).toMatchObject({ code: 'INVARIANT_VIOLATION', details: { sqlState: '23001' } });
    expect(res.body.error.details.reason).toMatch(/At least one ACTIVE SUPER_ADMIN must remain/);
    expect(await t.prisma.userRole.count({ where: { role: { key: 'SUPER_ADMIN' } } })).toBe(1);
  });
});
