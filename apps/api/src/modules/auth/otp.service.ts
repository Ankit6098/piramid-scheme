import { Injectable } from '@nestjs/common';
import type { ChallengePurpose } from '@app/shared';
import { CryptoService } from '../../common/crypto/crypto.service';
import { hexDigestEquals } from '../../common/crypto/hmac';
import { randomNumericCode } from '../../common/crypto/tokens';
import { OtpMailer } from '../../common/outbox/otp-mailer';
import { Prisma, PrismaService, type Db, type Tx } from '../../common/prisma/prisma.service';
import {
  decideSend,
  isBlocked,
  OTP_POLICY,
  summarizeHistory,
  type ChallengeHistorySummary,
  type OtpSendDecision,
} from './domain/otp-policy';
import { SecurityNoticesService } from './security-notices.service';

/** Advisory-lock namespace serializing code issuance per (address, purpose) (two-int form). */
const CHALLENGE_LOCK_CLASS = 7302;

export interface PendingRegistration {
  fullName: string;
  passwordHash: string;
  referralCodeId: string | null;
}

export interface IssueChallengeInput {
  email: string;
  purpose: ChallengePurpose;
  userId?: string | null;
  /** LOGIN_MFA: the session the code may elevate. */
  sessionId?: string | null;
  /** EMAIL_VERIFICATION for a not-yet-created account. */
  pending?: PendingRegistration | null;
  /** Resend counter carried over from the challenge being replaced (informational). */
  sendCount?: number;
}

export interface IssuedChallenge {
  challengeId: string;
  expiresAt: Date;
}

/** The challenge row returned by a verification attempt (pending payload included). */
export interface AttemptedChallenge {
  id: string;
  email: string;
  userId: string | null;
  sessionId: string | null;
  pendingFullName: string | null;
  pendingPasswordHash: string | null;
  pendingReferralCodeId: string | null;
}

export type AttemptResult = { ok: true; challenge: AttemptedChallenge } | { ok: false };

export interface AttemptScope {
  purpose: ChallengePurpose;
  /** Address the code was sent to (all purposes except user-scoped EMAIL_CHANGE). */
  email?: string;
  /** LOGIN_MFA: only the session that requested the code. */
  sessionId?: string;
  /** EMAIL_CHANGE: the account that started the change. */
  userId?: string;
}

interface AttemptRow {
  id: string;
  email: string;
  user_id: string | null;
  session_id: string | null;
  code_hash: string;
  pending_full_name: string | null;
  pending_password_hash: string | null;
  pending_referral_code_id: string | null;
}

/**
 * Email one-time codes (business rules §2): issuing (one open challenge per address + purpose, the
 * previous one invalidated in the same transaction, delivered only through OtpMailer), verification
 * (atomic attempt counter + constant-time compare, single use) and the DB-derived limits
 * (60 s cooldown, 5 codes/hour, ≥ 10 failed attempts in 24 h → blocked for 24 h + owner notice).
 */
@Injectable()
export class OtpService {
  readonly policy = OTP_POLICY;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly mailer: OtpMailer,
    private readonly notices: SecurityNoticesService,
  ) {}

  /** Serializes issuance for one (address, purpose) until the transaction ends. */
  async lock(tx: Tx, email: string, purpose: ChallengePurpose): Promise<void> {
    const key = `${purpose}:${email}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CHALLENGE_LOCK_CLASS}::int, hashtext(${key}))`;
  }

  /** History-derived limits for (address, purpose), optionally also per account (EMAIL_CHANGE). */
  async history(db: Db, scope: { email: string; purpose: ChallengePurpose; userId?: string }, now: Date): Promise<ChallengeHistorySummary> {
    const since = new Date(now.getTime() - this.policy.failedWindowMs);
    const rows = await db.emailChallenge.findMany({
      where: {
        purpose: scope.purpose,
        createdAt: { gt: since },
        OR: [{ email: scope.email }, ...(scope.userId ? [{ userId: scope.userId }] : [])],
      },
      select: { createdAt: true, attempts: true, consumedAt: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return summarizeHistory(rows, now, this.policy);
  }

  async sendDecision(
    db: Db,
    scope: { email: string; purpose: ChallengePurpose; userId?: string },
    now: Date,
    options: { enforceCooldown?: boolean } = {},
  ): Promise<OtpSendDecision> {
    return decideSend(await this.history(db, scope, now), now, options, this.policy);
  }

  async isVerificationBlocked(db: Db, scope: { email: string; purpose: ChallengePurpose; userId?: string }, now: Date): Promise<boolean> {
    return isBlocked(await this.history(db, scope, now), this.policy);
  }

  /** Closes every open challenge for (address, purpose) and scrubs pending registration payloads. */
  async invalidateOpen(tx: Db, where: { email?: string; userId?: string; purpose: ChallengePurpose }, now: Date): Promise<number> {
    if (!where.email && !where.userId) return 0;
    const res = await tx.emailChallenge.updateMany({
      where: {
        purpose: where.purpose,
        consumedAt: null,
        invalidatedAt: null,
        ...(where.email ? { email: where.email } : {}),
        ...(where.userId ? { userId: where.userId } : {}),
      },
      data: { invalidatedAt: now, pendingFullName: null, pendingPasswordHash: null, pendingReferralCodeId: null },
    });
    return res.count;
  }

  /**
   * Issues a new code: invalidates the open challenge for (address, purpose) first, inserts the new
   * row (code stored only as HMAC) and enqueues the email through OtpMailer — all inside `tx`.
   * Callers must hold `lock()` and have checked `sendDecision()`.
   */
  async issue(tx: Tx, input: IssueChallengeInput, now: Date): Promise<IssuedChallenge> {
    const email = input.email.trim().toLowerCase();
    await this.invalidateOpen(tx, { email, purpose: input.purpose }, now);
    const code = randomNumericCode(6);
    const expiresAt = new Date(now.getTime() + this.policy.ttlMs);
    const challenge = await tx.emailChallenge.create({
      data: {
        email,
        purpose: input.purpose,
        userId: input.userId ?? null,
        sessionId: input.sessionId ?? null,
        codeHash: this.crypto.otpCodeHash(input.purpose, email, code),
        maxAttempts: this.policy.maxAttempts,
        sendCount: Math.max(1, input.sendCount ?? 1),
        lastSentAt: now,
        createdAt: now,
        expiresAt,
        pendingFullName: input.pending?.fullName ?? null,
        pendingPasswordHash: input.pending?.passwordHash ?? null,
        pendingReferralCodeId: input.pending?.referralCodeId ?? null,
      },
      select: { id: true },
    });
    await this.mailer.enqueue(tx, { challengeId: challenge.id, code, email, purpose: input.purpose });
    return { challengeId: challenge.id, expiresAt };
  }

  /**
   * One verification attempt, committed on its own (so failed attempts always count):
   * `UPDATE … SET attempts = attempts + 1 WHERE <open, unexpired, attempts < max> RETURNING`, then a
   * constant-time compare with `otpCodeHash(purpose, address, code)`. Does NOT consume — call
   * `consume(tx, id)` in the transaction that applies the effect.
   */
  async attempt(scope: AttemptScope, code: string, now: Date): Promise<AttemptResult> {
    if (!scope.email && !scope.userId && !scope.sessionId) return { ok: false };
    const conditions = [
      Prisma.sql`"purpose" = ${scope.purpose}::"ChallengePurpose"`,
      Prisma.sql`"consumed_at" IS NULL`,
      Prisma.sql`"invalidated_at" IS NULL`,
      Prisma.sql`"expires_at" > ${now}`,
      Prisma.sql`"attempts" < "max_attempts"`,
    ];
    if (scope.email) conditions.push(Prisma.sql`"email" = ${scope.email}`);
    if (scope.sessionId) conditions.push(Prisma.sql`"session_id" = ${scope.sessionId}::uuid`);
    if (scope.userId) conditions.push(Prisma.sql`"user_id" = ${scope.userId}::uuid`);
    const rows = await this.prisma.$queryRaw<AttemptRow[]>`
      UPDATE "email_challenges" SET "attempts" = "attempts" + 1
      WHERE "id" = (
        SELECT "id" FROM "email_challenges"
        WHERE ${Prisma.join(conditions, ' AND ')}
        ORDER BY "created_at" DESC
        LIMIT 1
        FOR UPDATE
      ) AND "attempts" < "max_attempts"
      RETURNING "id", "email", "user_id", "session_id", "code_hash",
                "pending_full_name", "pending_password_hash", "pending_referral_code_id"`;
    const row = rows[0];
    const expected = this.crypto.otpCodeHash(scope.purpose, row?.email ?? scope.email ?? '', code);
    if (!row || !hexDigestEquals(row.code_hash, expected)) return { ok: false };
    return {
      ok: true,
      challenge: {
        id: row.id,
        email: row.email,
        userId: row.user_id,
        sessionId: row.session_id,
        pendingFullName: row.pending_full_name,
        pendingPasswordHash: row.pending_password_hash,
        pendingReferralCodeId: row.pending_referral_code_id,
      },
    };
  }

  /** Single use: marks the challenge consumed (and scrubs its pending payload). False if it lost a race. */
  async consume(tx: Db, challengeId: string, now: Date): Promise<boolean> {
    const res = await tx.emailChallenge.updateMany({
      where: { id: challengeId, consumedAt: null, invalidatedAt: null },
      data: { consumedAt: now, pendingFullName: null, pendingPasswordHash: null, pendingReferralCodeId: null },
    });
    return res.count === 1;
  }

  /**
   * After a failed attempt: when the address has now reached the 24 h failure cap, notify its owner
   * (once per day; `notifyTo` is the account's current address, or the challenge address when no
   * account exists yet).
   */
  async afterFailure(
    scope: { email: string; purpose: ChallengePurpose; userId?: string },
    owner: { notifyTo: string; name?: string | null },
    now: Date,
  ): Promise<void> {
    const summary = await this.history(this.prisma, scope, now);
    if (!isBlocked(summary, this.policy)) return;
    await this.prisma.runInTransaction((tx) =>
      this.notices.otpCapReached(tx, { to: owner.notifyTo, name: owner.name ?? null, purpose: scope.purpose }, now),
    );
  }
}
