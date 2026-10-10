import { Injectable } from '@nestjs/common';
import {
  OTP_RESEND_COOLDOWN_SECONDS,
  MfaRequiredReason,
  type MfaEmailSentResponseDto,
  type MfaVerifiedResponseDto,
  type TotpSetupResponseDto,
} from '@app/shared';
import type { AuthContext } from '../../common/auth/auth-context';
import { SessionTokenService, type CreatedSession } from '../../common/auth/session-token.service';
import { AuditService } from '../../common/audit/audit.service';
import { maskEmail } from '../../common/audit/mask';
import { RequestContext } from '../../common/context/request-context';
import { CryptoService } from '../../common/crypto/crypto.service';
import { buildOtpauthUri, generateTotpSecret, verifyTotp } from '../../common/crypto/totp';
import { forbidden, invalidState, mfaRequired } from '../../common/errors/app-error';
import { PrismaService, type Tx } from '../../common/prisma/prisma.service';
import { LoginThrottleService } from '../../common/throttle/login-throttle.service';
import { AppConfig } from '../../config/app-config';
import { otpInvalid, otpSendRefused, totpInvalid } from './auth-errors';
import { AuthService, type SignedIn } from './auth.service';
import { OtpService } from './otp.service';
import { SecurityNoticesService } from './security-notices.service';

/** An unconfirmed authenticator must be confirmed within this window (else set it up again). */
export const TOTP_SETUP_WINDOW_MS = 30 * 60_000;

/**
 * Admin second factor (business rules §2 "Admin MFA"):
 * - no confirmed TOTP factor yet: email code bound to THIS session (LOGIN_MFA) → session elevated with
 *   EMAIL_OTP → TOTP setup (secret shown once, stored encrypted) → confirm with a first code →
 *   factor confirmed + session elevated with TOTP (admin access);
 * - with a factor: TOTP code (replay-safe via `last_used_step`) → session elevated with TOTP.
 * Every elevation rotates the session token (SessionTokenService.elevateSession). Email OTP never
 * grants admin access by itself.
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionTokenService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly loginThrottle: LoginThrottleService,
    private readonly config: AppConfig,
    private readonly otp: OtpService,
    private readonly authService: AuthService,
    private readonly notices: SecurityNoticesService,
  ) {}

  private assertAdmin(auth: AuthContext): void {
    if (!auth.isAdmin) throw forbidden('Only administrative accounts use this verification step');
  }

  private assertNeedsEnrollment(auth: AuthContext): void {
    this.assertAdmin(auth);
    if (auth.hasTotpFactor) throw invalidState('An authenticator app is already set up. Enter its code instead');
  }

  // ─── Email code (first admin sign-in without an authenticator) ─────────────

  async sendEmailCode(auth: AuthContext): Promise<MfaEmailSentResponseDto> {
    this.assertNeedsEnrollment(auth);
    if (auth.mfaMethod) throw invalidState('This session is already verified. Continue with the authenticator setup');
    const now = new Date();
    return this.prisma.runInTransaction(async (tx) => {
      await this.otp.lock(tx, auth.email, 'LOGIN_MFA');
      const decision = await this.otp.sendDecision(tx, { email: auth.email, purpose: 'LOGIN_MFA', userId: auth.userId }, now);
      if (!decision.allowed) throw otpSendRefused(decision);
      const issued = await this.otp.issue(
        tx,
        { email: auth.email, purpose: 'LOGIN_MFA', userId: auth.userId, sessionId: auth.sessionId },
        now,
      );
      return {
        sentTo: maskEmail(auth.email),
        expiresAt: issued.expiresAt.toISOString(),
        resendAfterSeconds: OTP_RESEND_COOLDOWN_SECONDS,
      };
    });
  }

  async verifyEmailCode(auth: AuthContext, code: string): Promise<SignedIn<MfaVerifiedResponseDto>> {
    this.assertNeedsEnrollment(auth);
    if (auth.mfaMethod) throw invalidState('This session is already verified. Continue with the authenticator setup');
    const now = new Date();
    const history = { email: auth.email, purpose: 'LOGIN_MFA' as const, userId: auth.userId };
    if (await this.otp.isVerificationBlocked(this.prisma, history, now)) throw otpInvalid();
    // Only a code requested by THIS session can elevate it.
    const attempt = await this.otp.attempt({ purpose: 'LOGIN_MFA', email: auth.email, sessionId: auth.sessionId }, code, now);
    if (!attempt.ok) {
      await this.otp.afterFailure(history, { notifyTo: auth.email, name: auth.fullName }, now);
      throw otpInvalid();
    }
    const session = await this.prisma.runInTransaction(async (tx) => {
      if (!(await this.otp.consume(tx, attempt.challenge.id, now))) throw otpInvalid();
      const elevated = await this.sessions.elevateSession(tx, auth.sessionId, 'EMAIL_OTP');
      await this.audit.record(tx, {
        action: 'auth.mfa.email_verified',
        resourceType: 'session',
        resourceId: elevated.sessionId,
        after: { mfaMethod: 'EMAIL_OTP' },
      });
      return elevated;
    });
    return this.signedIn(session);
  }

  // ─── TOTP enrollment ───────────────────────────────────────────────────────

  /** New secret (shown once), stored encrypted as an UNCONFIRMED factor; an older unconfirmed one is revoked. */
  async setupTotp(auth: AuthContext): Promise<TotpSetupResponseDto> {
    this.assertNeedsEnrollment(auth);
    if (!auth.mfaMethod) {
      throw mfaRequired('Verify the code we email you before setting up an authenticator', {
        reason: MfaRequiredReason.TotpEnrollmentRequired,
      });
    }
    const now = new Date();
    const secret = generateTotpSecret();
    await this.prisma.runInTransaction(async (tx) => {
      await this.lockUser(tx, auth.userId);
      const confirmed = await tx.userMfaFactor.count({
        where: { userId: auth.userId, kind: 'TOTP', revokedAt: null, confirmedAt: { not: null } },
      });
      if (confirmed > 0) throw invalidState('An authenticator app is already set up. Enter its code instead');
      await tx.userMfaFactor.updateMany({
        where: { userId: auth.userId, kind: 'TOTP', revokedAt: null, confirmedAt: null },
        data: { revokedAt: now },
      });
      const factor = await tx.userMfaFactor.create({
        data: {
          userId: auth.userId,
          kind: 'TOTP',
          secretEnc: this.crypto.encryptTotpSecret(secret, auth.userId),
          createdAt: now,
        },
        select: { id: true },
      });
      await this.audit.record(tx, {
        action: 'auth.mfa.totp_setup_started',
        resourceType: 'user_mfa_factor',
        resourceId: factor.id,
      });
    });
    const issuer = this.config.security.totpIssuer;
    return {
      otpauthUri: buildOtpauthUri({ secret, accountName: auth.email, issuer }),
      secret,
      issuer,
      accountName: auth.email,
    };
  }

  /** First code from the new authenticator → factor confirmed + session elevated with TOTP. */
  async confirmTotp(auth: AuthContext, code: string): Promise<SignedIn<MfaVerifiedResponseDto>> {
    this.assertNeedsEnrollment(auth);
    if (!auth.mfaMethod) {
      throw mfaRequired('Verify the code we email you before setting up an authenticator', {
        reason: MfaRequiredReason.TotpEnrollmentRequired,
      });
    }
    const now = new Date();
    const throttleKey = this.throttleKey(auth.userId);
    const ip = RequestContext.ip;
    this.loginThrottle.assertAllowed(await this.loginThrottle.check(throttleKey, ip));

    const factor = await this.prisma.userMfaFactor.findFirst({
      where: { userId: auth.userId, kind: 'TOTP', revokedAt: null, confirmedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, secretEnc: true, lastUsedStep: true, createdAt: true },
    });
    if (!factor || now.getTime() - factor.createdAt.getTime() > TOTP_SETUP_WINDOW_MS) {
      throw invalidState('The authenticator setup has expired. Start the setup again');
    }
    const result = verifyTotp(this.crypto.decryptTotpSecret(factor.secretEnc, auth.userId), code, {
      lastUsedStep: factor.lastUsedStep,
      now: now.getTime(),
    });
    if (!result.ok) {
      await this.loginThrottle.recordFailure(throttleKey, ip);
      throw totpInvalid();
    }
    const session = await this.prisma.runInTransaction(async (tx) => {
      const updated = await tx.userMfaFactor.updateMany({
        where: {
          id: factor.id,
          confirmedAt: null,
          revokedAt: null,
          OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: BigInt(result.step) } }],
        },
        data: { confirmedAt: now, lastUsedStep: BigInt(result.step), lastUsedAt: now },
      });
      if (updated.count !== 1) throw totpInvalid();
      const elevated = await this.sessions.elevateSession(tx, auth.sessionId, 'TOTP');
      await this.audit.record(tx, {
        action: 'auth.mfa.totp_enrolled',
        resourceType: 'user_mfa_factor',
        resourceId: factor.id,
        after: { mfaMethod: 'TOTP' },
      });
      return elevated;
    });
    await this.loginThrottle.reset(throttleKey, ip);
    return this.signedIn(session);
  }

  // ─── TOTP verification ─────────────────────────────────────────────────────

  async verifyTotpCode(auth: AuthContext, code: string): Promise<SignedIn<MfaVerifiedResponseDto>> {
    this.assertAdmin(auth);
    const now = new Date();
    const { factorId, step } = await this.checkTotp(auth, code, now);
    const session = await this.prisma.runInTransaction(async (tx) => {
      await this.markStepUsed(tx, factorId, step, now);
      const elevated = await this.sessions.elevateSession(tx, auth.sessionId, 'TOTP');
      await this.audit.record(tx, {
        action: 'auth.mfa.totp_verified',
        resourceType: 'session',
        resourceId: elevated.sessionId,
        after: { mfaMethod: 'TOTP' },
      });
      return elevated;
    });
    await this.loginThrottle.reset(this.throttleKey(auth.userId), RequestContext.ip);
    return this.signedIn(session);
  }

  /**
   * Self-service authenticator reset (users slice: POST /users/me/mfa/totp/reset): the CURRENT code
   * is required; the factor is revoked, other sessions are signed out and SUPER_ADMINs notified. The
   * caller then enrolls a new authenticator (/auth/mfa/totp/setup works because this session already
   * holds a verified second factor).
   */
  async resetTotp(auth: AuthContext, code: string): Promise<void> {
    this.assertAdmin(auth);
    const now = new Date();
    const { factorId, step } = await this.checkTotp(auth, code, now);
    await this.prisma.runInTransaction(async (tx) => {
      const updated = await tx.userMfaFactor.updateMany({
        where: {
          id: factorId,
          revokedAt: null,
          confirmedAt: { not: null },
          OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: BigInt(step) } }],
        },
        data: { revokedAt: now, lastUsedStep: BigInt(step), lastUsedAt: now },
      });
      if (updated.count !== 1) throw totpInvalid();
      await this.sessions.revokeAllForUser(tx, auth.userId, 'mfa_reset', { exceptSessionId: auth.sessionId });
      await this.audit.record(tx, {
        action: 'user.mfa.totp_reset',
        resourceType: 'user_mfa_factor',
        resourceId: factorId,
        after: { revoked: true },
      });
      await this.notices.notifySuperAdmins(tx, {
        subjectUserId: auth.userId,
        title: 'Authenticator reset on an admin account',
        paragraphs: [
          `The admin account ${maskEmail(auth.email)} removed its authenticator app (the current code was provided) and must enroll a new one.`,
          'Other sessions of that account were signed out. If this was not expected, review the account.',
        ],
      });
    });
    await this.loginThrottle.reset(this.throttleKey(auth.userId), RequestContext.ip);
  }

  // ─── helpers ───────────────────────────────────────────────────────────────

  /** Throttled, replay-aware check of a code against the confirmed factor. */
  private async checkTotp(auth: AuthContext, code: string, now: Date): Promise<{ factorId: string; step: number }> {
    const throttleKey = this.throttleKey(auth.userId);
    const ip = RequestContext.ip;
    this.loginThrottle.assertAllowed(await this.loginThrottle.check(throttleKey, ip));
    const factor = await this.prisma.userMfaFactor.findFirst({
      where: { userId: auth.userId, kind: 'TOTP', revokedAt: null, confirmedAt: { not: null } },
      select: { id: true, secretEnc: true, lastUsedStep: true },
    });
    if (!factor) {
      throw mfaRequired('Set up an authenticator app first', { reason: MfaRequiredReason.TotpEnrollmentRequired });
    }
    const result = verifyTotp(this.crypto.decryptTotpSecret(factor.secretEnc, auth.userId), code, {
      lastUsedStep: factor.lastUsedStep,
      now: now.getTime(),
    });
    if (!result.ok) {
      await this.loginThrottle.recordFailure(throttleKey, ip);
      throw totpInvalid();
    }
    return { factorId: factor.id, step: result.step };
  }

  /** Replay protection: the step must be newer than the last accepted one (conditional UPDATE). */
  private async markStepUsed(tx: Tx, factorId: string, step: number, now: Date): Promise<void> {
    const updated = await tx.userMfaFactor.updateMany({
      where: {
        id: factorId,
        revokedAt: null,
        confirmedAt: { not: null },
        OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: BigInt(step) } }],
      },
      data: { lastUsedStep: BigInt(step), lastUsedAt: now },
    });
    if (updated.count !== 1) throw totpInvalid();
  }

  private async lockUser(tx: Tx, userId: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE`;
  }

  /** TOTP failures share the login backoff (per user + IP, and per IP). */
  private throttleKey(userId: string): string {
    return this.loginThrottle.emailKey(`totp:${userId}`);
  }

  private async signedIn(session: CreatedSession): Promise<SignedIn<MfaVerifiedResponseDto>> {
    return { response: { user: await this.authService.resolveSessionUser(session.token) }, session };
  }
}
