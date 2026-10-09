import { randomUUID } from 'node:crypto';
import type { RoleKey } from '@app/shared';
import { SessionTokenService } from '../../src/common/auth/session-token.service';
import type {
  BillingFrequency,
  EligibilityStatus,
  EnrollmentStatus,
  IneligibleAncestorBehavior,
  OfferingKind,
  OfferingStatus,
  PolicyStatus,
  ProgramStatus,
  QualifyingEventType,
  RewardCalcType,
  RewardUnit,
  RoundingMode,
  UserStatus,
} from '../../src/generated/prisma/client';
import { Prisma, type PrismaClient } from '../../src/generated/prisma/client';
import { generateReferralCode, hashPassword } from '../../prisma/seed-lib';
import type { TestApp, TestClient } from './app';

type Db = PrismaClient | Prisma.TransactionClient;

let seq = 0;
const next = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

// ─── users ──────────────────────────────────────────────────────────────────

export interface CreateUserOptions {
  email?: string;
  fullName?: string;
  /** Default ACTIVE. */
  status?: UserStatus;
  /** emailVerifiedAt = now (default true). */
  verified?: boolean;
  /** Default ['MEMBER']; MEMBER is always added. */
  roles?: RoleKey[];
  /** Sponsor user id → relationship + closure rows for all of the sponsor's ancestors. */
  sponsorId?: string | null;
  /** If set, stored as an argon2id hash (slow — only when the test logs in with a password). */
  password?: string;
  /** Program ids for program_admin_assignments (PROGRAM_ADMIN scope). */
  programScopes?: string[];
  referralCode?: string;
  createdAt?: Date;
}

export interface TestUser {
  id: string;
  email: string;
  fullName: string;
  status: UserStatus;
  roles: RoleKey[];
  referralCode: string;
  referralCodeId: string;
  sponsorId: string | null;
  password?: string;
}

/**
 * Writes a user exactly like registration would: user row, roles, depth-0 closure row, ancestor
 * closure rows (copied from the sponsor's paths, depth + 1), referral relationship and a global
 * referral code — all in one transaction (inserts only, so the immutability triggers are untouched).
 */
export async function createUser(prisma: PrismaClient, opts: CreateUserOptions = {}): Promise<TestUser> {
  const id = randomUUID();
  const email = (opts.email ?? `user-${next()}@example.test`).trim().toLowerCase();
  const fullName = opts.fullName ?? `Test User ${next()}`;
  const status = opts.status ?? 'ACTIVE';
  const roles = Array.from(new Set<RoleKey>(['MEMBER', ...(opts.roles ?? [])]));
  const passwordHash = opts.password ? await hashPassword(opts.password) : null;
  const referralCode = opts.referralCode ?? generateReferralCode();
  const sponsorId = opts.sponsorId ?? null;

  const referralCodeId = await prisma.$transaction(async (tx) => {
    await tx.user.create({
      data: {
        id,
        email,
        fullName,
        status,
        emailVerifiedAt: opts.verified === false ? null : new Date(),
        passwordHash,
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
        ...(status === 'SUSPENDED' ? { suspendedAt: new Date(), suspensionReason: 'test' } : {}),
      },
    });
    const roleRows = await tx.role.findMany({ where: { key: { in: roles } }, select: { id: true } });
    if (roleRows.length !== roles.length) throw new Error('Roles missing — call resetDatabase() first');
    await tx.userRole.createMany({ data: roleRows.map((r) => ({ userId: id, roleId: r.id })) });
    await tx.referralPath.create({ data: { ancestorId: id, descendantId: id, depth: 0 } });
    const code = await tx.referralCode.create({ data: { userId: id, code: referralCode }, select: { id: true } });
    if (sponsorId) {
      const sponsorCode = await tx.referralCode.findFirst({
        where: { userId: sponsorId, programId: null, isActive: true },
        select: { id: true },
      });
      await tx.referralRelationship.create({
        data: { childUserId: id, sponsorUserId: sponsorId, referralCodeId: sponsorCode?.id ?? null },
      });
      await tx.$executeRaw`
        INSERT INTO "referral_paths" ("ancestor_id", "descendant_id", "depth")
        SELECT "ancestor_id", ${id}::uuid, "depth" + 1 FROM "referral_paths" WHERE "descendant_id" = ${sponsorId}::uuid`;
    }
    if (opts.programScopes?.length) {
      await tx.programAdminAssignment.createMany({
        data: opts.programScopes.map((programId) => ({ userId: id, programId })),
      });
    }
    return code.id;
  });

  return {
    id,
    email,
    fullName,
    status,
    roles,
    referralCode,
    referralCodeId,
    sponsorId,
    ...(opts.password ? { password: opts.password } : {}),
  };
}

export interface LoginOptions {
  /** Default: true for admins (so /admin routes work), false for members. */
  mfaVerified?: boolean;
  ttlHours?: number;
}

export type LoggedInClient = TestClient & { sessionId: string; token: string; expiresAt: Date };

/**
 * Creates a session directly through SessionTokenService (no login flow) and returns a client whose
 * cookie jar carries `sid` (+ automatic CSRF pair on mutations).
 */
export async function loginAs(t: TestApp, user: Pick<TestUser, 'id' | 'roles'>, opts: LoginOptions = {}): Promise<LoggedInClient> {
  const sessions = t.get(SessionTokenService);
  const isAdmin = user.roles.some((r) => r !== 'MEMBER');
  const created = await sessions.createSession(t.prisma, {
    userId: user.id,
    mfaVerified: opts.mfaVerified ?? isAdmin,
    ip: '127.0.0.1',
    ua: 'vitest',
    ttlHours: opts.ttlHours ?? sessions.ttlHoursFor(user.roles),
  });
  return Object.assign(t.clientWithSession(created.token), {
    sessionId: created.sessionId,
    token: created.token,
    expiresAt: created.expiresAt,
  });
}

// ─── catalog / programs ────────────────────────────────────────────────────

export async function createOffering(
  prisma: Db,
  opts: { name?: string; kind?: OfferingKind; status?: OfferingStatus; sku?: string; createdById?: string } = {},
) {
  return prisma.offering.create({
    data: {
      name: opts.name ?? `Offering ${next()}`,
      kind: opts.kind ?? 'PRODUCT',
      status: opts.status ?? 'ACTIVE',
      sku: opts.sku ?? null,
      createdById: opts.createdById ?? null,
    },
  });
}

export interface CreateProgramOptions {
  offeringId?: string;
  code?: string;
  name?: string;
  status?: ProgramStatus;
  rewardUnit?: RewardUnit;
  currencyCode?: string;
  startsAt?: Date;
  endsAt?: Date | null;
  enrollmentOpensAt?: Date;
  enrollmentClosesAt?: Date | null;
  maxRewardDepth?: number;
  eligibility?: Prisma.InputJsonValue;
  /** Options (plans). Default: one free ONE_TIME option. Pass [] for none. */
  options?: Array<{
    name?: string;
    priceMinor?: bigint;
    billingFrequency?: BillingFrequency;
    durationDays?: number;
    isActive?: boolean;
  }>;
}

const DAY = 86_400_000;

export async function createProgram(prisma: Db, opts: CreateProgramOptions = {}) {
  const offeringId = opts.offeringId ?? (await createOffering(prisma)).id;
  const now = Date.now();
  const status = opts.status ?? 'ACTIVE';
  const currencyCode = opts.currencyCode ?? 'INR';
  const startsAt = opts.startsAt ?? new Date(now - 30 * DAY);
  const program = await prisma.program.create({
    data: {
      code: opts.code ?? `prog-${next()}`,
      name: opts.name ?? `Program ${next()}`,
      status,
      offeringId,
      startsAt,
      endsAt: opts.endsAt === undefined ? new Date(now + 365 * DAY) : opts.endsAt,
      enrollmentOpensAt: opts.enrollmentOpensAt ?? startsAt,
      enrollmentClosesAt: opts.enrollmentClosesAt === undefined ? null : opts.enrollmentClosesAt,
      maxRewardDepth: opts.maxRewardDepth ?? 5,
      rewardUnit: opts.rewardUnit ?? 'MONEY',
      currencyCode,
      eligibility: opts.eligibility ?? {},
      publishedAt: status === 'DRAFT' ? null : new Date(now - 29 * DAY),
    },
  });
  const optionDefs = opts.options ?? [{}];
  const options = [];
  for (const [i, o] of optionDefs.entries()) {
    options.push(
      await prisma.programOption.create({
        data: {
          programId: program.id,
          name: o.name ?? `Option ${i + 1}`,
          priceMinor: o.priceMinor ?? 0n,
          currencyCode,
          billingFrequency: o.billingFrequency ?? 'ONE_TIME',
          durationDays: o.durationDays ?? 365,
          isActive: o.isActive ?? true,
          sortOrder: i,
        },
      }),
    );
  }
  return { ...program, options };
}

export interface CreatePolicyOptions {
  programId: string;
  status?: PolicyStatus;
  version?: number;
  name?: string;
  triggerEventTypes?: QualifyingEventType[];
  maxDepth?: number;
  budgetBps?: number;
  maxTotalPerEventMinor?: bigint | null;
  minEventAmountMinor?: bigint;
  ineligibleAncestorBehavior?: IneligibleAncestorBehavior;
  roundingMode?: RoundingMode;
  requiresApproval?: boolean;
  requireActiveEnrollment?: boolean;
  effectiveFrom?: Date;
  effectiveTo?: Date | null;
  /** Default: level 1 = 10 %, level 2 = 5 %. */
  rules?: Array<{
    level: number;
    calcType?: RewardCalcType;
    fixedAmountMinor?: bigint | null;
    percentageBps?: number | null;
    capMinor?: bigint | null;
  }>;
}

/**
 * Creates a policy version with rules. Rules can only be inserted while the version is DRAFT
 * (trigger), so a PUBLISHED/RETIRED version is created as DRAFT, given its rules, then transitioned.
 */
export async function createPolicy(prisma: Db, opts: CreatePolicyOptions) {
  const status = opts.status ?? 'PUBLISHED';
  const version =
    opts.version ??
    ((await prisma.rewardPolicyVersion.aggregate({ where: { programId: opts.programId }, _max: { version: true } }))._max
      .version ?? 0) + 1;
  const rules = opts.rules ?? [
    { level: 1, calcType: 'PERCENTAGE' as const, percentageBps: 1000 },
    { level: 2, calcType: 'PERCENTAGE' as const, percentageBps: 500 },
  ];
  const policy = await prisma.rewardPolicyVersion.create({
    data: {
      programId: opts.programId,
      version,
      status: 'DRAFT',
      name: opts.name ?? `Policy v${version}`,
      triggerEventTypes: opts.triggerEventTypes ?? ['PRODUCT_SALE'],
      maxDepth: opts.maxDepth ?? Math.max(1, ...rules.map((r) => r.level)),
      budgetBps: opts.budgetBps ?? 2000,
      maxTotalPerEventMinor: opts.maxTotalPerEventMinor ?? null,
      minEventAmountMinor: opts.minEventAmountMinor ?? 0n,
      ineligibleAncestorBehavior: opts.ineligibleAncestorBehavior ?? 'FORFEIT',
      roundingMode: opts.roundingMode ?? 'HALF_UP',
      requiresApproval: opts.requiresApproval ?? true,
      requireActiveEnrollment: opts.requireActiveEnrollment ?? true,
      effectiveFrom: opts.effectiveFrom ?? new Date(Date.now() - 7 * DAY),
      effectiveTo: opts.effectiveTo ?? null,
    },
  });
  for (const r of rules) {
    const calcType = r.calcType ?? (r.fixedAmountMinor != null ? 'FIXED' : 'PERCENTAGE');
    await prisma.rewardRule.create({
      data: {
        policyVersionId: policy.id,
        level: r.level,
        calcType,
        fixedAmountMinor: calcType === 'FIXED' ? (r.fixedAmountMinor ?? 100n) : null,
        percentageBps: calcType === 'PERCENTAGE' ? (r.percentageBps ?? 100) : null,
        capMinor: r.capMinor ?? null,
      },
    });
  }
  if (status === 'DRAFT') return prisma.rewardPolicyVersion.findUniqueOrThrow({ where: { id: policy.id }, include: { rules: true } });
  const publishedAt = new Date();
  await prisma.rewardPolicyVersion.update({ where: { id: policy.id }, data: { status: 'PUBLISHED', publishedAt } });
  if (status === 'RETIRED') {
    await prisma.rewardPolicyVersion.update({
      where: { id: policy.id },
      data: { status: 'RETIRED', retiredAt: new Date(), ...(opts.effectiveTo ? {} : { effectiveTo: new Date() }) },
    });
  }
  return prisma.rewardPolicyVersion.findUniqueOrThrow({ where: { id: policy.id }, include: { rules: true } });
}

export interface CreateEnrollmentOptions {
  userId: string;
  programId: string;
  optionId?: string;
  status?: EnrollmentStatus;
  eligibilityStatus?: EligibilityStatus;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
  sponsorUserId?: string | null;
}

export async function createEnrollment(prisma: Db, opts: CreateEnrollmentOptions) {
  const option =
    opts.optionId !== undefined
      ? await prisma.programOption.findUniqueOrThrow({ where: { id: opts.optionId } })
      : await prisma.programOption.findFirstOrThrow({ where: { programId: opts.programId }, orderBy: { sortOrder: 'asc' } });
  const status = opts.status ?? 'ACTIVE';
  const active = status === 'ACTIVE' || status === 'EXPIRED';
  const effectiveFrom = opts.effectiveFrom !== undefined ? opts.effectiveFrom : active ? new Date(Date.now() - DAY) : null;
  const effectiveTo =
    opts.effectiveTo !== undefined
      ? opts.effectiveTo
      : effectiveFrom
        ? new Date(effectiveFrom.getTime() + option.durationDays * DAY)
        : null;
  return prisma.programEnrollment.create({
    data: {
      userId: opts.userId,
      programId: opts.programId,
      optionId: option.id,
      optionSnapshot: {
        name: option.name,
        priceMinor: option.priceMinor.toString(),
        currencyCode: option.currencyCode,
        billingFrequency: option.billingFrequency,
        durationDays: option.durationDays,
      },
      termsVersion: '1.0',
      status,
      eligibilityStatus: opts.eligibilityStatus ?? (status === 'ACTIVE' ? 'ELIGIBLE' : 'PENDING_REVIEW'),
      sponsorUserId: opts.sponsorUserId ?? null,
      effectiveFrom,
      effectiveTo,
    },
  });
}

export { Prisma };
