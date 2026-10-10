import type { MemberDashboardDto } from '@app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LedgerService } from '../src/modules/ledger/ledger.service';
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
  postRewardForTest,
  processEventForTest,
  type TestUser,
} from './utils/factories';

const SALE_AMOUNT = 123_457n;
const CUSTOMER_REF = 'CUST-PRIVATE-REF-77';
const EXTERNAL_ID = 'ORD-PRIVATE-EXT-99';

describe('GET /users/me/dashboard', () => {
  let t: TestApp;
  let admin: TestUser;
  let reviewer: TestUser;
  let anita: TestUser;
  let rahul: TestUser;
  let priya: TestUser;
  let program: { id: string; name: string };
  let eventId: string;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
    await disconnectTestPrisma();
  });

  /** anita > rahul > priya. Sale by priya → rahul L1 POSTED, anita L2 PENDING; a second sale → anita L2 POSTED then REVERSED. */
  beforeEach(async () => {
    await resetDatabase();
    admin = await factoryAdmin(t.prisma);
    reviewer = await createUser(t.prisma, { roles: ['FINANCE_REVIEWER'] });
    program = await createProgram(t.prisma, { name: 'Wellness Plan', currencyCode: 'INR' });
    const other = await createProgram(t.prisma, { name: 'Second Program' });
    const policy = await createPolicy(t.prisma, { programId: program.id });
    anita = await createUser(t.prisma, { fullName: 'Anita Sharma' });
    rahul = await createUser(t.prisma, { fullName: 'Rahul Verma', sponsor: anita });
    priya = await createUser(t.prisma, { fullName: 'Priya Secretname', sponsor: rahul });
    await createEnrollment(t.prisma, { userId: anita.id, programId: program.id });
    await createEnrollment(t.prisma, { userId: anita.id, programId: other.id, status: 'PENDING' });
    await createEnrollment(t.prisma, { userId: rahul.id, programId: program.id });
    await createEnrollment(t.prisma, { userId: priya.id, programId: program.id });

    const e1 = await createEvent(t.prisma, {
      programId: program.id,
      subjectUserId: priya.id,
      amountMinor: SALE_AMOUNT,
      customerReference: CUSTOMER_REF,
      externalId: EXTERNAL_ID,
    });
    eventId = e1.id;
    const r1 = await processEventForTest(t.prisma, {
      eventId: e1.id,
      policyVersionId: policy.id,
      rewards: [
        { recipientUserId: rahul.id, level: 1, amountMinor: 12_345n },
        { recipientUserId: anita.id, level: 2, amountMinor: 6_172n },
      ],
    });
    await postRewardForTest(t.prisma, r1.rewards[0]!.id, reviewer.id);

    const e2 = await createEvent(t.prisma, { programId: program.id, subjectUserId: priya.id, amountMinor: 40_000n });
    const r2 = await processEventForTest(t.prisma, {
      eventId: e2.id,
      policyVersionId: policy.id,
      rewards: [{ recipientUserId: anita.id, level: 2, amountMinor: 2_000n }],
    });
    await postRewardForTest(t.prisma, r2.rewards[0]!.id, reviewer.id);
    const ledger = t.get(LedgerService);
    await t.prisma.$transaction((tx) => ledger.reverseReward(tx, r2.rewards[0]!.id, reviewer.id, 'Refund test'));

    await t.prisma.notification.createMany({
      data: [
        { userId: anita.id, type: 'announcement.terms', title: 'Updated terms', body: 'Read the new terms', createdAt: new Date(Date.now() - 1000) },
        { userId: anita.id, type: 'announcement.old', title: 'Old news', body: 'Already read', readAt: new Date() },
        { userId: anita.id, type: 'enrollment.status', title: 'Enrollment active', body: 'Welcome' },
        { userId: rahul.id, type: 'reward.status', title: 'Rahul private', body: 'Only for Rahul' },
      ],
    });
  });

  const dashboardOf = async (user: TestUser) =>
    (await (await loginAs(t, user)).get('/api/v1/users/me/dashboard').expect(200)).body.data as MemberDashboardDto;

  it('summarizes my verification, enrollments, team and reward buckets', async () => {
    const d = await dashboardOf(anita);
    expect(d.user).toEqual({
      id: anita.id,
      fullName: 'Anita Sharma',
      firstName: 'Anita',
      status: 'ACTIVE',
      emailVerified: true,
      memberSince: expect.any(String),
    });
    expect(d.enrollments.active).toBe(1);
    expect(d.enrollments.pending).toBe(1);
    expect(d.enrollments.items.map((e) => e.status).sort()).toEqual(['ACTIVE', 'PENDING']);
    expect(d.enrollments.items.find((e) => e.status === 'ACTIVE')).toMatchObject({ program: { id: program.id, name: 'Wellness Plan' } });
    expect(d.referrals).toEqual({ directCount: 1, teamSize: 2 });
    expect(d.rewards).toEqual([
      { rewardUnit: 'MONEY', currencyCode: 'INR', earnedMinor: '0', pendingMinor: '6172', reversedMinor: '2000' },
    ]);
    expect(d.unreadNotifications).toBe(2);
    expect(d.announcements.map((a) => a.title)).toEqual(['Updated terms']);

    const r = await dashboardOf(rahul);
    expect(r.rewards).toEqual([{ rewardUnit: 'MONEY', currencyCode: 'INR', earnedMinor: '12345', pendingMinor: '0', reversedMinor: '0' }]);
    expect(r.referrals).toEqual({ directCount: 1, teamSize: 1 });
  });

  it('shows recent activity (reward status changes + notifications) newest first', async () => {
    const d = await dashboardOf(anita);
    const rewards = d.recentActivity.filter((a) => a.kind === 'REWARD');
    expect(rewards).toHaveLength(2);
    expect(rewards).toContainEqual(
      expect.objectContaining({ programName: 'Wellness Plan', level: 2, amountMinor: '2000', status: 'REVERSED', rewardUnit: 'MONEY', currencyCode: 'INR' }),
    );
    expect(rewards).toContainEqual(expect.objectContaining({ amountMinor: '6172', status: 'PENDING_APPROVAL' }));
    expect(d.recentActivity.filter((a) => a.kind === 'NOTIFICATION')).toHaveLength(3);
    const times = d.recentActivity.map((a) => a.at);
    expect(times).toEqual([...times].sort().reverse());
  });

  it('never exposes the sale subject, sale amount, customer reference, external id or other members’ data', async () => {
    for (const user of [anita, rahul]) {
      const body = JSON.stringify(await dashboardOf(user));
      expect(body).not.toContain(priya.id);
      expect(body).not.toContain('Secretname');
      expect(body).not.toContain(priya.email);
      expect(body).not.toContain(SALE_AMOUNT.toString());
      expect(body).not.toContain(CUSTOMER_REF);
      expect(body).not.toContain(EXTERNAL_ID);
      expect(body).not.toContain(eventId);
      expect(body).not.toMatch(/trace|subject|customerReference|externalId|occurredAt/);
    }
    expect(JSON.stringify(await dashboardOf(anita))).not.toContain('Rahul private');
  });

  it('counts the team only to depth 10', async () => {
    const root = await createUser(t.prisma);
    let parent = root;
    for (let i = 0; i < 12; i++) parent = await createUser(t.prisma, { sponsor: parent });
    const d = await dashboardOf(root);
    expect(d.referrals).toEqual({ directCount: 1, teamSize: 10 });
    expect(d.rewards).toEqual([]);
    expect(d.recentActivity).toEqual([]);
  });

  it('requires a session', async () => {
    await t.client().get('/api/v1/users/me/dashboard').expect(401);
  });
});
