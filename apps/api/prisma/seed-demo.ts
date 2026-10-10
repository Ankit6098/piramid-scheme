/**
 * Demo dataset (SEED_DEMO_DATA=true). Idempotent: skipped when the demo program exists.
 *
 * Builds a realistic, compliant scenario through the real domain services:
 * - an approved product and a live program with four plans and a published reward policy
 *   (rewards come only from product sales — never from joining or plan payments);
 * - a referral tree (Anita → Rahul/Amit → …) created with the registration write protocol;
 * - activated enrollments (offline payments recorded by an admin);
 * - sales recorded by an admin, processed by the reward engine, some approved and posted by a
 *   separate finance reviewer (four-eyes), the rest left pending.
 */
import { createHash, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { AuditService } from '../src/common/audit/audit.service';
import { OutboxService } from '../src/common/outbox/outbox.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { loadConfig, type AppConfig } from '../src/config/app-config';
import { EnrollmentsService } from '../src/modules/enrollments/enrollments.service';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { HierarchyService } from '../src/modules/referrals/hierarchy.service';
import { ReferralsService } from '../src/modules/referrals/referrals.service';
import { RewardEngineService } from '../src/modules/rewards/reward-engine.service';

export const DEMO_PROGRAM_CODE = 'demo-wellness';

interface DemoMember {
  key: string;
  name: string;
  sponsor: string | null;
}

/** The example tree from the product brief. */
const TREE: DemoMember[] = [
  { key: 'anita', name: 'Anita Sharma', sponsor: null },
  { key: 'rahul', name: 'Rahul Verma', sponsor: 'anita' },
  { key: 'amit', name: 'Amit Patel', sponsor: 'anita' },
  { key: 'priya', name: 'Priya Nair', sponsor: 'rahul' },
  { key: 'kiran', name: 'Kiran Rao', sponsor: 'rahul' },
  { key: 'neha', name: 'Neha Gupta', sponsor: 'priya' },
  { key: 'vikram', name: 'Vikram Singh', sponsor: 'priya' },
  { key: 'sunita', name: 'Sunita Das', sponsor: 'amit' },
];

/** Sales of the product credited to members (major currency units). */
const SALES: Array<{ member: string; amount: number; approve: boolean }> = [
  { member: 'neha', amount: 4500, approve: true },
  { member: 'vikram', amount: 12000, approve: true },
  { member: 'kiran', amount: 2500, approve: false },
  { member: 'sunita', amount: 8000, approve: false },
  { member: 'priya', amount: 6400, approve: true },
];

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

export async function seedDemo(superAdminEmail: string): Promise<void> {
  // Services are wired by hand: tsx does not emit the decorator metadata Nest DI relies on.
  const config = loadConfig() as AppConfig;
  const prisma = new PrismaService(config);
  const outbox = new OutboxService();
  const audit = new AuditService();
  const notifications = new NotificationsService(outbox, prisma);
  const referrals = new ReferralsService(outbox);
  const ledger = new LedgerService();
  const engine = new RewardEngineService(
    prisma,
    new HierarchyService(),
    new EnrollmentsService(prisma, audit, notifications, outbox, config),
    ledger,
    notifications,
    audit,
  );
  try {
    await prisma.$connect();

    if (await prisma.program.findUnique({ where: { code: DEMO_PROGRAM_CODE } })) {
      console.log('[seed] demo data already present — skipped');
      return;
    }
    const admin = await prisma.user.findUnique({ where: { email: superAdminEmail.trim().toLowerCase() } });
    if (!admin) throw new Error('Demo data needs the seeded super admin');
    const password = process.env.SEED_DEMO_PASSWORD ?? 'Demo@12345678';
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const roles = new Map((await prisma.role.findMany()).map((r) => [r.key, r.id]));

    /** Registration write protocol: user → tree rows (shared lock) → code → roles, one transaction. */
    async function createMember(email: string, fullName: string, sponsorId: string | null, extraRoles: string[] = []) {
      return prisma.$transaction(async (tx) => {
        const id = randomUUID();
        await tx.user.create({
          data: { id, email, fullName, status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash, passwordChangedAt: new Date() },
        });
        let sponsor: { sponsorUserId: string; referralCodeId: string } | null = null;
        if (sponsorId) {
          const code = await tx.referralCode.findFirstOrThrow({ where: { userId: sponsorId, programId: null, isActive: true } });
          sponsor = await referrals.resolveCodeForRegistration(tx, code.code);
        }
        await referrals.attachNewMember(tx, {
          userId: id,
          sponsorUserId: sponsor?.sponsorUserId ?? null,
          referralCodeId: sponsor?.referralCodeId ?? null,
          registrationIp: '198.51.100.10',
          registrationUserAgent: 'seed',
        });
        const roleIds = ['MEMBER', ...extraRoles].map((k) => roles.get(k)).filter((v): v is string => Boolean(v));
        await tx.userRole.createMany({ data: roleIds.map((roleId) => ({ userId: id, roleId, grantedById: admin!.id })) });
        return id;
      });
    }

    const finance = await createMember('finance@example.com', 'Farah Khan', null, ['FINANCE_REVIEWER']);
    const programAdmin = await createMember('programs@example.com', 'Dev Malhotra', null, ['PROGRAM_ADMIN']);

    // ── Catalog & program ─────────────────────────────────────────────────────
    const settings = await prisma.platformSettings.findUniqueOrThrow({ where: { id: 1 } });
    const offering = await prisma.offering.create({
      data: {
        name: 'Premium Wellness Kit',
        description: 'Monthly box of certified wellness products delivered to the customer.',
        kind: 'PRODUCT',
        sku: 'DEMO-WELLNESS-KIT',
        status: 'ACTIVE',
        createdById: admin.id,
        approvedById: admin.id,
        approvedAt: new Date(),
      },
    });
    const now = new Date();
    const program = await prisma.program.create({
      data: {
        code: DEMO_PROGRAM_CODE,
        name: 'Wellness Partners',
        description: 'Share the Premium Wellness Kit. Rewards are earned only when customers buy the product.',
        offeringId: offering.id,
        startsAt: new Date(now.getTime() - 60_000),
        enrollmentOpensAt: new Date(now.getTime() - 60_000),
        maxRewardDepth: 5,
        rewardUnit: settings.rewardUnit,
        currencyCode: settings.currencyCode,
        currencyMinorUnits: settings.currencyMinorUnits,
        termsText: 'Plan fees pay for product deliveries. Plan fees never generate rewards. Rewards require approval.',
        createdById: admin.id,
        updatedById: admin.id,
        eligibility: { requireSponsor: false, minAccountAgeDays: 0 },
      },
    });
    await prisma.programAdminAssignment.create({ data: { userId: programAdmin, programId: program.id } });
    const scale = 10n ** BigInt(settings.currencyMinorUnits);
    const plans = [
      { name: 'Monthly', price: 2000n, frequency: 'MONTHLY' as const, days: 30 },
      { name: 'Quarterly', price: 3000n, frequency: 'QUARTERLY' as const, days: 90 },
      { name: 'Half-yearly', price: 5000n, frequency: 'HALF_YEARLY' as const, days: 182 },
      { name: 'Annual', price: 10000n, frequency: 'YEARLY' as const, days: 365 },
    ];
    const options = [];
    for (const [i, p] of plans.entries()) {
      options.push(
        await prisma.programOption.create({
          data: {
            programId: program.id,
            name: p.name,
            description: `${p.name} delivery plan`,
            priceMinor: p.price * scale,
            currencyCode: settings.currencyCode,
            billingFrequency: p.frequency,
            durationDays: p.days,
            sortOrder: i,
          },
        }),
      );
    }

    const policy = await prisma.rewardPolicyVersion.create({
      data: {
        programId: program.id,
        version: 1,
        name: 'Launch policy',
        notes: 'Five levels, 20% total budget of each product sale.',
        triggerEventTypes: ['PRODUCT_SALE', 'SUBSCRIPTION_RENEWAL'],
        maxDepth: 5,
        budgetBps: 2000,
        pointsPerCurrencyUnit: settings.pointsPerCurrencyUnit,
        requiresApproval: true,
        effectiveFrom: new Date(),
        createdById: admin.id,
        rules: {
          create: [
            { level: 1, calcType: 'PERCENTAGE', percentageBps: 800 },
            { level: 2, calcType: 'PERCENTAGE', percentageBps: 500 },
            { level: 3, calcType: 'PERCENTAGE', percentageBps: 300 },
            { level: 4, calcType: 'PERCENTAGE', percentageBps: 200 },
            { level: 5, calcType: 'PERCENTAGE', percentageBps: 200 },
          ],
        },
      },
    });
    await prisma.rewardPolicyVersion.update({
      where: { id: policy.id },
      data: { status: 'PUBLISHED', publishedAt: new Date(), publishedById: admin.id },
    });
    await prisma.program.update({
      where: { id: program.id },
      data: { status: 'ACTIVE', publishedAt: new Date(), updatedById: admin.id },
    });
    await tick();

    // ── Members, enrollments ─────────────────────────────────────────────────
    const ids = new Map<string, string>();
    for (const m of TREE) {
      const id = await createMember(`${m.key}@example.com`, m.name, m.sponsor ? ids.get(m.sponsor)! : null);
      ids.set(m.key, id);
    }
    const monthly = options[0]!;
    for (const m of TREE) {
      const userId = ids.get(m.key)!;
      const sponsorUserId = m.sponsor ? ids.get(m.sponsor)! : null;
      const enrollment = await prisma.programEnrollment.create({
        data: {
          userId,
          programId: program.id,
          optionId: monthly.id,
          optionSnapshot: {
            optionId: monthly.id,
            name: monthly.name,
            priceMinor: monthly.priceMinor.toString(),
            currencyCode: monthly.currencyCode,
            billingFrequency: monthly.billingFrequency,
            durationDays: monthly.durationDays,
            renewalPolicy: monthly.renewalPolicy,
          },
          termsVersion: program.termsVersion,
          sponsorUserId,
        },
      });
      const from = new Date();
      await prisma.programEnrollment.update({
        where: { id: enrollment.id },
        data: {
          status: 'ACTIVE',
          eligibilityStatus: 'ELIGIBLE',
          effectiveFrom: from,
          effectiveTo: new Date(from.getTime() + monthly.durationDays * 86_400_000),
          paymentReference: `DEMO-PAY-${m.key.toUpperCase()}`,
          paymentAmountMinor: monthly.priceMinor,
          paymentRecordedAt: from,
          paymentRecordedById: admin.id,
        },
      });
    }
    await tick();

    // ── Sales → engine → four-eyes approval ─────────────────────────────────
    let counter = 1001;
    for (const sale of SALES) {
      const amountMinor = BigInt(sale.amount) * scale;
      const externalId = `DEMO-ORDER-${counter}`;
      const occurredAt = new Date();
      const canonical = JSON.stringify({ programId: program.id, externalId, amountMinor: amountMinor.toString(), subject: ids.get(sale.member) });
      const event = await prisma.qualifyingEvent.create({
        data: {
          programId: program.id,
          offeringId: offering.id,
          type: 'PRODUCT_SALE',
          source: 'ADMIN_MANUAL',
          externalId,
          requestHash: createHash('sha256').update(canonical).digest('hex'),
          customerReference: `CUST-${counter}`,
          subjectUserId: ids.get(sale.member)!,
          amountMinor,
          currencyCode: program.currencyCode,
          occurredAt,
          description: 'Demo product sale',
          recordedById: admin.id,
        },
      });
      counter += 1;
      const result = await engine.processEvent(event.id);
      if (sale.approve) {
        for (const rewardId of result.rewardIds) {
          await prisma.$transaction(async (tx) => {
            await tx.reward.update({
              where: { id: rewardId },
              data: { status: 'APPROVED', approvedById: finance, approvedAt: new Date() },
            });
            await ledger.postReward(tx, rewardId, finance);
          });
        }
      }
    }

    console.log(
      `[seed] demo data created: program "${program.name}", ${TREE.length} members (password ${password === 'Demo@12345678' ? 'Demo@12345678' : 'from SEED_DEMO_PASSWORD'}), ` +
        `${SALES.length} sales; finance@example.com reviews rewards, programs@example.com manages the program`,
    );
  } finally {
    await prisma.$disconnect();
  }
}
