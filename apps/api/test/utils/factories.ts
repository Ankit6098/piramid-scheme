import { createHash, randomUUID } from 'node:crypto';
import type { MfaMethod, RoleKey } from '@app/shared';
import { SessionTokenService } from '../../src/common/auth/session-token.service';
import { CryptoService } from '../../src/common/crypto/crypto.service';
import { generateTotpSecret } from '../../src/common/crypto/totp';
import { lockReferralTreeShared } from '../../src/common/prisma/referral-tree-lock';
import type {
  BillingFrequency,
  EligibilityStatus,
  EnrollmentStatus,
  IneligibleAncestorBehavior,
  OfferingKind,
  OfferingStatus,
  PolicyStatus,
  ProgramStatus,
  QualifyingEventSource,
  QualifyingEventType,
  RewardCalcType,
  RewardStatus,
  RewardUnit,
  RoundingMode,
  UserStatus,
} from '../../src/generated/prisma/client';
import { Prisma, type PrismaClient } from '../../src/generated/prisma/client';
import { generateReferralCode, hashPassword } from '../../prisma/seed-lib';
import type { TestApp, TestClient } from './app';

/**
 * Test data factories that satisfy the database integrity triggers (see the integrity migration and
 * docs/database.md). Everything is "now-relative": the DB refuses back-dated policies, coverage
 * periods and sales outside the program period, so tests cannot fabricate history.
 *
 * Every factory accepts the root client or an interactive-transaction client. Multi-statement
 * factories run in their own transaction when given the root client. Never call them inside a
 * transaction that uses savepoints (the referral triggers recognise "rows created in this
 * transaction" by xmin).
 */
export type Db = PrismaClient | Prisma.TransactionClient;

const DAY = 86_400_000;
let seq = 0;
const next = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * Runs `fn` in a transaction (root client) or directly (already a transaction client).
 * NB: Prisma 7 transaction clients also expose `$transaction`, which opens a nested SAVEPOINT — that
 * would break the xmin-based referral triggers — so the root client is detected via `$connect`.
 */
export async function inTx<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if (typeof (db as PrismaClient).$connect === 'function') {
    return (db as PrismaClient).$transaction((tx) => fn(tx), { timeout: 20_000, maxWait: 10_000 });
  }
  return fn(db as Prisma.TransactionClient);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// ─── users ──────────────────────────────────────────────────────────────────

export interface CreateUserOptions {
  email?: string;
  fullName?: string;
  /** Default ACTIVE. ACTIVE requires a verified email (DB CHECK). */
  status?: UserStatus;
  /** emailVerifiedAt = now (default true). */
  verified?: boolean;
  /** Default ['MEMBER']; MEMBER is always added. */
  roles?: RoleKey[];
  /** Sponsor (user or id): must be ACTIVE + verified with an active referral code (DB trigger). */
  sponsor?: Pick<TestUser, 'id'> | string | null;
  /** Alias of `sponsor` (id). */
  sponsorId?: string | null;
  /** If set, stored as an argon2id hash (slow — only when the test logs in with a password). */
  password?: string;
  /** Program ids for program_admin_assignments (PROGRAM_ADMIN scope). */
  programScopes?: string[];
  referralCode?: string;
  registrationIp?: string | null;
  /** Account age (users.created_at is not guarded), e.g. for `minAccountAgeDays` rules. */
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
 * Creates a member exactly like the registration that verifies an email would, in ONE transaction:
 * users row → pg_advisory_xact_lock_shared(7301,1) → depth-0 closure row → (sponsor) relationship
 * via the sponsor's active referral code → ancestor rows (sponsor's rows + 1) → own referral code →
 * roles → program scopes.
 */
export async function createUser(db: Db, opts: CreateUserOptions = {}): Promise<TestUser> {
  const id = randomUUID();
  const email = (opts.email ?? `user-${next()}@example.test`).trim().toLowerCase();
  const fullName = opts.fullName ?? `Test User ${next()}`;
  const status = opts.status ?? 'ACTIVE';
  const roles = Array.from(new Set<RoleKey>(['MEMBER', ...(opts.roles ?? [])]));
  const passwordHash = opts.password ? await hashPassword(opts.password) : null;
  const referralCode = opts.referralCode ?? generateReferralCode();
  const sponsorId = (typeof opts.sponsor === 'string' ? opts.sponsor : opts.sponsor?.id) ?? opts.sponsorId ?? null;

  const referralCodeId = await inTx(db, async (tx) => {
    await tx.user.create({
      data: {
        id,
        email,
        fullName,
        status,
        emailVerifiedAt: opts.verified === false ? null : new Date(),
        passwordHash,
        ...(passwordHash ? { passwordChangedAt: new Date() } : {}),
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
        ...(status === 'SUSPENDED' ? { suspendedAt: new Date(), suspensionReason: 'test' } : {}),
      },
    });
    await lockReferralTreeShared(tx);
    await tx.referralPath.create({ data: { ancestorId: id, descendantId: id, depth: 0 } });
    if (sponsorId) {
      const sponsorCode = await tx.referralCode.findFirst({
        where: { userId: sponsorId, programId: null, isActive: true },
        select: { id: true },
      });
      if (!sponsorCode) throw new Error(`createUser: sponsor ${sponsorId} has no active referral code`);
      await tx.referralRelationship.create({
        data: {
          childUserId: id,
          sponsorUserId: sponsorId,
          referralCodeId: sponsorCode.id,
          source: 'REGISTRATION',
          registrationIp: opts.registrationIp ?? null,
          registrationUserAgent: 'vitest',
        },
      });
      await tx.$executeRaw`
        INSERT INTO "referral_paths" ("ancestor_id", "descendant_id", "depth")
        SELECT "ancestor_id", ${id}::uuid, "depth" + 1 FROM "referral_paths" WHERE "descendant_id" = ${sponsorId}::uuid`;
    }
    const code = await tx.referralCode.create({ data: { userId: id, code: referralCode }, select: { id: true } });
    const roleRows = await tx.role.findMany({ where: { key: { in: roles } }, select: { id: true } });
    if (roleRows.length !== roles.length) throw new Error('Roles missing — call resetDatabase() first');
    await tx.userRole.createMany({ data: roleRows.map((r) => ({ userId: id, roleId: r.id })) });
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

export const FACTORY_ADMIN_EMAIL = 'factory-admin@example.test';

/**
 * A SUPER_ADMIN used as the approver/publisher/recorder in factories (offering approval, program and
 * policy publication, ADMIN_MANUAL sales, payment records). Created on first use after each reset.
 * It has no sponsor and no downline, so it may record a sale for anyone but itself.
 */
export async function factoryAdmin(db: Db): Promise<TestUser> {
  const existing = await db.user.findUnique({
    where: { email: FACTORY_ADMIN_EMAIL },
    select: { id: true, email: true, fullName: true, status: true, referralCodes: { select: { id: true, code: true }, take: 1 } },
  });
  if (existing) {
    return {
      id: existing.id,
      email: existing.email,
      fullName: existing.fullName,
      status: existing.status,
      roles: ['MEMBER', 'SUPER_ADMIN'],
      referralCode: existing.referralCodes[0]?.code ?? '',
      referralCodeId: existing.referralCodes[0]?.id ?? '',
      sponsorId: null,
    };
  }
  return createUser(db, { email: FACTORY_ADMIN_EMAIL, fullName: 'Factory Admin', roles: ['SUPER_ADMIN'] });
}

// ─── sessions ───────────────────────────────────────────────────────────────

export interface LoginOptions {
  /**
   * Second factor of the session. Default: 'TOTP' for admins (so /admin routes work), 'NONE' for
   * members. 'EMAIL_OTP'/'TOTP' go through SessionTokenService.elevateSession (token rotation).
   */
  mfa?: 'NONE' | MfaMethod;
  /** Override mfa_verified_at afterwards (e.g. 13 h ago to test the 12 h admin window). */
  mfaVerifiedAt?: Date;
  ttlHours?: number;
}

export type LoggedInClient = TestClient & { sessionId: string; token: string; expiresAt: Date };

/**
 * Creates a session directly (no login flow) and returns a client whose cookie jar carries `sid`
 * (+ automatic CSRF pair on mutations).
 */
export async function loginAs(t: TestApp, user: Pick<TestUser, 'id' | 'roles'>, opts: LoginOptions = {}): Promise<LoggedInClient> {
  const sessions = t.get(SessionTokenService);
  const isAdmin = user.roles.some((r) => r !== 'MEMBER');
  const mfa = opts.mfa ?? (isAdmin ? 'TOTP' : 'NONE');
  const created = await t.prisma.runInTransaction(async (tx) => {
    const s = await sessions.createSession(tx, {
      userId: user.id,
      ip: '127.0.0.1',
      ua: 'vitest',
      ttlHours: opts.ttlHours ?? sessions.ttlHoursFor(user.roles),
    });
    return mfa === 'NONE' ? s : sessions.elevateSession(tx, s.sessionId, mfa);
  });
  if (opts.mfaVerifiedAt && mfa !== 'NONE') {
    await t.prisma.session.update({ where: { id: created.sessionId }, data: { mfaVerifiedAt: opts.mfaVerifiedAt } });
  }
  return Object.assign(t.clientWithSession(created.token), {
    sessionId: created.sessionId,
    token: created.token,
    expiresAt: created.expiresAt,
  });
}

/** Enrolls a TOTP factor (secret encrypted with MFA_ENCRYPTION_KEY). Returns the base32 secret. */
export async function createTotpFactor(
  t: TestApp,
  user: Pick<TestUser, 'id'>,
  opts: { confirmed?: boolean; secret?: string } = {},
): Promise<{ factorId: string; secret: string }> {
  const secret = opts.secret ?? generateTotpSecret();
  const factor = await t.prisma.userMfaFactor.create({
    data: {
      userId: user.id,
      kind: 'TOTP',
      secretEnc: t.get(CryptoService).encryptTotpSecret(secret, user.id),
      confirmedAt: opts.confirmed === false ? null : new Date(),
    },
    select: { id: true },
  });
  return { factorId: factor.id, secret };
}

// ─── catalog / programs ────────────────────────────────────────────────────

export async function createOffering(
  db: Db,
  opts: { name?: string; kind?: OfferingKind; status?: OfferingStatus; sku?: string; createdById?: string; approvedById?: string } = {},
) {
  const status = opts.status ?? 'ACTIVE';
  const approvedById = status === 'ACTIVE' ? (opts.approvedById ?? (await factoryAdmin(db)).id) : null;
  return db.offering.create({
    data: {
      name: opts.name ?? `Offering ${next()}`,
      kind: opts.kind ?? 'PRODUCT',
      status,
      sku: opts.sku ?? null,
      createdById: opts.createdById ?? null,
      approvedById,
      approvedAt: approvedById ? new Date() : null,
    },
  });
}

export interface CreateProgramOptions {
  offeringId?: string;
  code?: string;
  name?: string;
  /** Default ACTIVE. Reached through the lifecycle (DRAFT → … ) as the DB requires. */
  status?: ProgramStatus;
  rewardUnit?: RewardUnit;
  currencyCode?: string;
  startsAt?: Date;
  endsAt?: Date | null;
  enrollmentOpensAt?: Date;
  enrollmentClosesAt?: Date | null;
  maxRewardDepth?: number;
  lateEventGraceDays?: number;
  eligibility?: Prisma.InputJsonValue;
  termsVersion?: string;
  /** Options (plans) in the program currency. Default: one free ONE_TIME option. Pass [] for none. */
  options?: Array<{
    name?: string;
    priceMinor?: bigint;
    billingFrequency?: BillingFrequency;
    durationDays?: number;
    isActive?: boolean;
  }>;
}

/**
 * Inserts the program as DRAFT (unit/currency/minor units snapshot), adds its options, then walks
 * the lifecycle to `status` (publish = UPDATE to ACTIVE/SCHEDULED with published_at, by the factory
 * admin). Default dates: started 30 days ago, ends in a year, enrollment open since the start.
 */
export async function createProgram(db: Db, opts: CreateProgramOptions = {}) {
  return inTx(db, async (tx) => {
    const offeringId = opts.offeringId ?? (await createOffering(tx)).id;
    const now = Date.now();
    const status = opts.status ?? 'ACTIVE';
    const currency = await tx.currency.findUniqueOrThrow({ where: { code: opts.currencyCode ?? 'INR' } });
    const startsAt = opts.startsAt ?? new Date(now - 30 * DAY);
    const program = await tx.program.create({
      data: {
        code: opts.code ?? `prog-${next()}`,
        name: opts.name ?? `Program ${next()}`,
        status: 'DRAFT',
        offeringId,
        startsAt,
        endsAt: opts.endsAt === undefined ? new Date(now + 365 * DAY) : opts.endsAt,
        enrollmentOpensAt: opts.enrollmentOpensAt ?? startsAt,
        enrollmentClosesAt: opts.enrollmentClosesAt === undefined ? null : opts.enrollmentClosesAt,
        maxRewardDepth: opts.maxRewardDepth ?? 5,
        lateEventGraceDays: opts.lateEventGraceDays ?? 30,
        rewardUnit: opts.rewardUnit ?? 'MONEY',
        currencyCode: currency.code,
        currencyMinorUnits: currency.minorUnits,
        eligibility: opts.eligibility ?? {},
        termsVersion: opts.termsVersion ?? '1.0',
      },
    });
    const options = [];
    for (const [i, o] of (opts.options ?? [{}]).entries()) {
      options.push(
        await tx.programOption.create({
          data: {
            programId: program.id,
            name: o.name ?? `Option ${i + 1}`,
            priceMinor: o.priceMinor ?? 0n,
            currencyCode: currency.code,
            billingFrequency: o.billingFrequency ?? 'ONE_TIME',
            durationDays: o.durationDays ?? 365,
            isActive: o.isActive ?? true,
            sortOrder: i,
          },
        }),
      );
    }
    if (status !== 'DRAFT') {
      const actor = (await factoryAdmin(tx)).id;
      const path: ProgramStatus[] =
        status === 'SCHEDULED' ? ['SCHEDULED']
        : status === 'ACTIVE' ? ['ACTIVE']
        : status === 'PAUSED' ? ['ACTIVE', 'PAUSED']
        : status === 'COMPLETED' ? ['ACTIVE', 'COMPLETED']
        : ['ACTIVE', 'COMPLETED', 'ARCHIVED'];
      for (const s of path) {
        await tx.program.update({
          where: { id: program.id },
          data: {
            status: s,
            updatedById: actor,
            ...(s === 'ACTIVE' || s === 'SCHEDULED' ? { publishedAt: new Date() } : {}),
            ...(s === 'COMPLETED' && !program.endsAt ? { endsAt: new Date() } : {}),
          },
        });
      }
    }
    const current = await tx.program.findUniqueOrThrow({ where: { id: program.id } });
    return { ...current, options };
  });
}

export interface CreatePolicyOptions {
  programId: string;
  /** Default PUBLISHED. */
  status?: PolicyStatus;
  version?: number;
  name?: string;
  triggerEventTypes?: QualifyingEventType[];
  maxDepth?: number;
  budgetBps?: number;
  maxTotalPerEventMinor?: bigint | null;
  minEventAmountMinor?: bigint;
  pointsPerCurrencyUnit?: number;
  ineligibleAncestorBehavior?: IneligibleAncestorBehavior;
  roundingMode?: RoundingMode;
  requiresApproval?: boolean;
  requireActiveEnrollment?: boolean;
  /** Default now − 30 s (the DB refuses publication with effectiveFrom more than 1 min in the past). */
  effectiveFrom?: Date;
  effectiveTo?: Date | null;
  /** Publisher (default: the factory SUPER_ADMIN; auto-approving policies need a SUPER_ADMIN). */
  publishedById?: string;
  /** Before publishing, close the program's open published version at this version's effectiveFrom. */
  closeCurrent?: boolean;
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
 * Inserts a DRAFT version + rules (rules can only change while DRAFT), then publishes it with an
 * UPDATE (published_by = SUPER_ADMIN, effectiveFrom ≥ now − 1 min) and optionally retires it
 * (effectiveTo = max(now, effectiveFrom)).
 */
export async function createPolicy(db: Db, opts: CreatePolicyOptions) {
  return inTx(db, async (tx) => {
    const status = opts.status ?? 'PUBLISHED';
    const version =
      opts.version ??
      ((await tx.rewardPolicyVersion.aggregate({ where: { programId: opts.programId }, _max: { version: true } }))._max.version ?? 0) + 1;
    const rules = opts.rules ?? [
      { level: 1, calcType: 'PERCENTAGE' as const, percentageBps: 1000 },
      { level: 2, calcType: 'PERCENTAGE' as const, percentageBps: 500 },
    ];
    const effectiveFrom = opts.effectiveFrom ?? new Date(Date.now() - 30_000);
    const policy = await tx.rewardPolicyVersion.create({
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
        pointsPerCurrencyUnit: opts.pointsPerCurrencyUnit ?? 1,
        ineligibleAncestorBehavior: opts.ineligibleAncestorBehavior ?? 'FORFEIT',
        roundingMode: opts.roundingMode ?? 'HALF_UP',
        requiresApproval: opts.requiresApproval ?? true,
        requireActiveEnrollment: opts.requireActiveEnrollment ?? true,
        effectiveFrom,
        effectiveTo: opts.effectiveTo ?? null,
      },
    });
    for (const r of rules) {
      const calcType = r.calcType ?? (r.fixedAmountMinor != null ? 'FIXED' : 'PERCENTAGE');
      await tx.rewardRule.create({
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
    if (status !== 'DRAFT') {
      if (opts.closeCurrent) {
        await tx.rewardPolicyVersion.updateMany({
          where: { programId: opts.programId, status: 'PUBLISHED', effectiveTo: null, id: { not: policy.id } },
          data: { effectiveTo: effectiveFrom },
        });
      }
      const publishedById = opts.publishedById ?? (await factoryAdmin(tx)).id;
      await tx.rewardPolicyVersion.update({
        where: { id: policy.id },
        data: { status: 'PUBLISHED', publishedAt: new Date(), publishedById },
      });
      if (status === 'RETIRED') {
        const now = new Date();
        await tx.rewardPolicyVersion.update({
          where: { id: policy.id },
          data: {
            status: 'RETIRED',
            retiredAt: now,
            effectiveTo: opts.effectiveTo ?? new Date(Math.max(now.getTime(), effectiveFrom.getTime())),
          },
        });
      }
    }
    return tx.rewardPolicyVersion.findUniqueOrThrow({ where: { id: policy.id }, include: { rules: true } });
  });
}

// ─── enrollments ────────────────────────────────────────────────────────────

export interface CreateEnrollmentOptions {
  userId: string;
  programId: string;
  optionId?: string;
  /** PENDING | ACTIVE (default) | CANCELLED | REJECTED. EXPIRED cannot be fabricated (no back-dating). */
  status?: EnrollmentStatus;
  eligibilityStatus?: EligibilityStatus;
  /** Coverage start for ACTIVE (default now; ≥ now − 1 min, DB). */
  effectiveFrom?: Date;
  /** Default: the member's sponsor from the referral tree. */
  sponsorUserId?: string | null;
  /** Paid options: offline payment record (defaults: unique reference, amount = option price). */
  paymentReference?: string;
  paymentAmountMinor?: bigint;
  /** CANCELLED from 'ACTIVE' (default: activated, then cancelled now) or from 'PENDING'. */
  cancelledFrom?: 'ACTIVE' | 'PENDING';
}

/**
 * Enrollment following the DB rules: program must be ACTIVE with an open window and the member
 * ACTIVE + verified. Free options are inserted ACTIVE; paid options are inserted PENDING and activated
 * with a payment record (reference, amount, time, recorded by the factory admin). Coverage starts now.
 */
export async function createEnrollment(db: Db, opts: CreateEnrollmentOptions) {
  const status = opts.status ?? 'ACTIVE';
  if (status === 'EXPIRED') throw new Error('createEnrollment: EXPIRED enrollments cannot be created (coverage cannot be back-dated)');
  return inTx(db, async (tx) => {
    const option =
      opts.optionId !== undefined
        ? await tx.programOption.findUniqueOrThrow({ where: { id: opts.optionId } })
        : await tx.programOption.findFirstOrThrow({ where: { programId: opts.programId }, orderBy: { sortOrder: 'asc' } });
    const program = await tx.program.findUniqueOrThrow({ where: { id: opts.programId }, select: { termsVersion: true } });
    const sponsorUserId =
      opts.sponsorUserId !== undefined
        ? opts.sponsorUserId
        : ((await tx.referralRelationship.findUnique({ where: { childUserId: opts.userId }, select: { sponsorUserId: true } }))
            ?.sponsorUserId ?? null);
    const paid = option.priceMinor > 0n;
    const activate = status === 'ACTIVE' || (status === 'CANCELLED' && (opts.cancelledFrom ?? 'ACTIVE') === 'ACTIVE');
    const effectiveFrom = opts.effectiveFrom ?? new Date();
    const period = {
      effectiveFrom,
      effectiveTo: new Date(effectiveFrom.getTime() + option.durationDays * DAY),
      eligibilityStatus: opts.eligibilityStatus ?? ('ELIGIBLE' as const),
    };
    const base = {
      userId: opts.userId,
      programId: opts.programId,
      optionId: option.id,
      optionSnapshot: {
        optionId: option.id,
        name: option.name,
        priceMinor: option.priceMinor.toString(),
        currencyCode: option.currencyCode,
        billingFrequency: option.billingFrequency,
        durationDays: option.durationDays,
        renewalPolicy: option.renewalPolicy,
      },
      termsVersion: program.termsVersion,
      sponsorUserId,
    };

    let enrollment;
    if (activate && !paid) {
      enrollment = await tx.programEnrollment.create({ data: { ...base, status: 'ACTIVE', ...period } });
    } else {
      enrollment = await tx.programEnrollment.create({
        data: { ...base, status: 'PENDING', eligibilityStatus: opts.eligibilityStatus ?? 'PENDING_REVIEW' },
      });
      if (activate) {
        enrollment = await tx.programEnrollment.update({
          where: { id: enrollment.id },
          data: {
            status: 'ACTIVE',
            ...period,
            paymentReference: opts.paymentReference ?? `PAY-${randomUUID()}`,
            paymentAmountMinor: opts.paymentAmountMinor ?? option.priceMinor,
            paymentRecordedAt: new Date(),
            paymentRecordedById: (await factoryAdmin(tx)).id,
          },
        });
      }
    }
    if (status === 'CANCELLED') {
      await tx.$executeRaw`
        UPDATE "program_enrollments"
           SET "status" = 'CANCELLED', "cancelled_at" = now(), "status_reason" = 'test',
               "effective_to" = CASE WHEN "effective_from" IS NULL THEN NULL ELSE greatest("effective_from", now()) END,
               "updated_at" = now()
         WHERE "id" = ${enrollment.id}::uuid`;
      enrollment = await tx.programEnrollment.findUniqueOrThrow({ where: { id: enrollment.id } });
    } else if (status === 'REJECTED') {
      enrollment = await tx.programEnrollment.update({
        where: { id: enrollment.id },
        data: { status: 'REJECTED', eligibilityStatus: 'INELIGIBLE', statusReason: 'test' },
      });
    }
    return enrollment;
  });
}

// ─── integrations / sales ───────────────────────────────────────────────────

export async function createApiClient(db: Db, programId: string, opts: { name?: string; createdById?: string } = {}) {
  const key = `test_${randomUUID().replace(/-/g, '')}`;
  const client = await db.apiClient.create({
    data: { name: opts.name ?? `Client ${next()}`, programId, keyPrefix: key.slice(0, 8), keyHash: sha256(key), createdById: opts.createdById ?? null },
  });
  return { ...client, apiKey: key };
}

export interface CreateEventOptions {
  programId: string;
  subjectUserId: string;
  type?: QualifyingEventType;
  /** Default ADMIN_MANUAL (recorded by the factory admin); API/WEBHOOK create an api client. */
  source?: QualifyingEventSource;
  externalId?: string;
  revision?: number;
  supersedesEventId?: string;
  amountMinor?: bigint;
  /** Default now (must lie in the program period and ≤ now + 5 min). */
  occurredAt?: Date;
  customerReference?: string;
  requestHash?: string;
  /** ADMIN_MANUAL: an admin who is neither the subject nor one of its uplines (DB SoD). */
  recordedById?: string;
  apiClientId?: string;
  /** RECEIVED (default) or REJECTED (with rejectionReason). */
  status?: 'RECEIVED' | 'REJECTED';
  rejectionReason?: string;
}

/** Records a sale of the program's offering (currency = program currency). */
export async function createEvent(db: Db, opts: CreateEventOptions) {
  const program = await db.program.findUniqueOrThrow({ where: { id: opts.programId }, select: { offeringId: true, currencyCode: true } });
  const source = opts.source ?? 'ADMIN_MANUAL';
  const externalId = opts.externalId ?? `ORD-${next()}`;
  const amountMinor = opts.amountMinor ?? 100_000n;
  const recordedById = source === 'ADMIN_MANUAL' ? (opts.recordedById ?? (await factoryAdmin(db)).id) : null;
  const apiClientId = source === 'ADMIN_MANUAL' ? null : (opts.apiClientId ?? (await createApiClient(db, opts.programId)).id);
  const status = opts.status ?? 'RECEIVED';
  return db.qualifyingEvent.create({
    data: {
      programId: opts.programId,
      offeringId: program.offeringId,
      type: opts.type ?? 'PRODUCT_SALE',
      source,
      externalId,
      revision: opts.revision ?? 0,
      supersedesEventId: opts.supersedesEventId ?? null,
      requestHash: opts.requestHash ?? sha256(`${opts.programId}:${externalId}:${amountMinor}:${opts.subjectUserId}`),
      customerReference: opts.customerReference ?? `CUST-${next()}`,
      subjectUserId: opts.subjectUserId,
      amountMinor,
      currencyCode: program.currencyCode,
      occurredAt: opts.occurredAt ?? new Date(),
      status,
      rejectionReason: status === 'REJECTED' ? (opts.rejectionReason ?? 'test') : null,
      recordedById,
      apiClientId,
    },
  });
}

export interface ProcessEventOptions {
  eventId: string;
  policyVersionId: string;
  /** Rewards to create (Σ must fit the budget; recipients must be uplines at ≥ level). */
  rewards: Array<{ recipientUserId: string; level: number; amountMinor: bigint }>;
  /** APPROVED only for auto-approving policies on non-manual sales (DB). Default PENDING_APPROVAL. */
  rewardStatus?: Extract<RewardStatus, 'PENDING_APPROVAL' | 'APPROVED'>;
}

/**
 * Stand-in for the reward engine in tests that need a processed sale with known rewards: binds the
 * policy, inserts the calculation snapshot (base/budget derived exactly like the DB re-derives them)
 * and the rewards, and marks the event PROCESSED — one transaction (totals are checked at COMMIT).
 */
export async function processEventForTest(db: Db, opts: ProcessEventOptions) {
  return inTx(db, async (tx) => {
    await tx.qualifyingEvent.update({ where: { id: opts.eventId }, data: { policyVersionId: opts.policyVersionId } });
    const event = await tx.qualifyingEvent.findUniqueOrThrow({
      where: { id: opts.eventId },
      include: { program: { select: { rewardUnit: true, currencyCode: true, currencyMinorUnits: true } } },
    });
    const policy = await tx.rewardPolicyVersion.findUniqueOrThrow({ where: { id: opts.policyVersionId } });
    const p = event.program;
    const base =
      p.rewardUnit === 'MONEY'
        ? event.amountMinor
        : (event.amountMinor * BigInt(policy.pointsPerCurrencyUnit)) / 10n ** BigInt(p.currencyMinorUnits);
    let budget = (base * BigInt(policy.budgetBps)) / 10_000n;
    if (policy.maxTotalPerEventMinor !== null && policy.maxTotalPerEventMinor < budget) budget = policy.maxTotalPerEventMinor;
    const total = opts.rewards.reduce((s, r) => s + r.amountMinor, 0n);
    const calculation = await tx.rewardCalculation.create({
      data: {
        eventId: event.id,
        policyVersionId: policy.id,
        outcome: opts.rewards.length ? 'REWARDS_CREATED' : 'NO_ELIGIBLE_RECIPIENTS',
        rewardUnit: p.rewardUnit,
        currencyCode: p.currencyCode,
        currencyMinorUnits: p.currencyMinorUnits,
        pointsPerCurrencyUnit: policy.pointsPerCurrencyUnit,
        baseMinor: base,
        budgetBps: policy.budgetBps,
        budgetMinor: budget,
        totalAllocatedMinor: total,
        trace: { test: true },
        engineVersion: 'test',
      },
    });
    const rewards = [];
    for (const r of opts.rewards) {
      rewards.push(
        await tx.reward.create({
          data: {
            calculationId: calculation.id,
            eventId: event.id,
            programId: event.programId,
            policyVersionId: policy.id,
            recipientUserId: r.recipientUserId,
            level: r.level,
            amountMinor: r.amountMinor,
            rewardUnit: p.rewardUnit,
            currencyCode: p.currencyCode,
            status: opts.rewardStatus ?? 'PENDING_APPROVAL',
            ...(opts.rewardStatus === 'APPROVED' ? { approvedAt: new Date() } : {}),
          },
        }),
      );
    }
    await tx.qualifyingEvent.update({ where: { id: event.id }, data: { status: 'PROCESSED', processedAt: new Date() } });
    return { calculation, rewards };
  });
}

/**
 * Stand-in for LedgerService in tests: approves (if pending) and posts a reward — accounts via
 * INSERT … ON CONFLICT DO NOTHING, `reward-posting:<id>` with exactly DEBIT platform expense / CREDIT
 * recipient payable — in one transaction.
 */
export async function postRewardForTest(db: Db, rewardId: string, approvedById: string) {
  return inTx(db, async (tx) => {
    const reward = await tx.reward.findUniqueOrThrow({ where: { id: rewardId } });
    if (reward.status === 'PENDING_APPROVAL') {
      await tx.reward.update({ where: { id: rewardId }, data: { status: 'APPROVED', approvedById, approvedAt: new Date() } });
    }
    await tx.$executeRaw`
      INSERT INTO "ledger_accounts" ("id", "type", "user_id", "reward_unit", "currency_code")
      VALUES (gen_random_uuid(), 'PLATFORM_REWARD_EXPENSE', NULL, ${reward.rewardUnit}::"RewardUnit", ${reward.currencyCode})
      ON CONFLICT DO NOTHING`;
    await tx.$executeRaw`
      INSERT INTO "ledger_accounts" ("id", "type", "user_id", "reward_unit", "currency_code")
      VALUES (gen_random_uuid(), 'MEMBER_REWARDS_PAYABLE', ${reward.recipientUserId}::uuid, ${reward.rewardUnit}::"RewardUnit", ${reward.currencyCode})
      ON CONFLICT DO NOTHING`;
    const expense = await tx.ledgerAccount.findFirstOrThrow({
      where: { type: 'PLATFORM_REWARD_EXPENSE', userId: null, rewardUnit: reward.rewardUnit, currencyCode: reward.currencyCode },
    });
    const payable = await tx.ledgerAccount.findFirstOrThrow({
      where: { type: 'MEMBER_REWARDS_PAYABLE', userId: reward.recipientUserId, rewardUnit: reward.rewardUnit, currencyCode: reward.currencyCode },
    });
    const txn = await tx.ledgerTransaction.create({
      data: {
        type: 'REWARD_POSTING',
        idempotencyKey: `reward-posting:${reward.id}`,
        rewardId: reward.id,
        entryCount: 2,
        debitTotalMinor: reward.amountMinor,
        postedById: approvedById,
      },
    });
    await tx.ledgerEntry.createMany({
      data: [
        { transactionId: txn.id, accountId: expense.id, direction: 'DEBIT', amountMinor: reward.amountMinor, rewardUnit: reward.rewardUnit, currencyCode: reward.currencyCode },
        { transactionId: txn.id, accountId: payable.id, direction: 'CREDIT', amountMinor: reward.amountMinor, rewardUnit: reward.rewardUnit, currencyCode: reward.currencyCode },
      ],
    });
    await tx.reward.update({ where: { id: rewardId }, data: { status: 'POSTED', postedAt: new Date() } });
    return { transactionId: txn.id, expenseAccountId: expense.id, payableAccountId: payable.id };
  });
}

export { Prisma };
