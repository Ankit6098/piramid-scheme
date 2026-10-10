import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  ErrorCode,
  isAdminRole,
  type AcceptedResponseDto,
  type ForgotPasswordRequest,
  type LoginRequest,
  type LoginResponseDto,
  type LogoutResponseDto,
  type PasswordResetResponseDto,
  type RegisterRequest,
  type ResendVerificationRequest,
  type ResetPasswordRequest,
  type SessionUserDto,
  type VerifyEmailRequest,
  type VerifyEmailResponseDto,
} from '@app/shared';
import type { AuthContext } from '../../common/auth/auth-context';
import { SessionAuthService } from '../../common/auth/session-auth.service';
import { SessionTokenService, type CreatedSession } from '../../common/auth/session-token.service';
import { AuditService } from '../../common/audit/audit.service';
import { maskEmail } from '../../common/audit/mask';
import { RequestContext } from '../../common/context/request-context';
import { sha256Hex } from '../../common/crypto/tokens';
import { AppError, isAppError } from '../../common/errors/app-error';
import { PrismaService, type Db, type Tx } from '../../common/prisma/prisma.service';
import { LoginThrottleService } from '../../common/throttle/login-throttle.service';
import { ReferralsService, type ResolvedReferralCode } from '../referrals/referrals.service';
import { ACCEPTED_MESSAGES, accepted, invalidCredentials, otpInvalid, otpSendRefused } from './auth-errors';
import { hourBucket } from './domain/otp-policy';
import { adminMfaStep, toSessionUserDto } from './domain/session-user';
import { OtpService, type IssuedChallenge } from './otp.service';
import { PasswordService } from './password.service';
import { SecurityNoticesService } from './security-notices.service';

/** A use case that signs the caller in: the controller sets the cookies from `session`. */
export interface SignedIn<T> {
  response: T;
  session: CreatedSession;
}

const ROLE_SELECT = { roles: { select: { role: { select: { key: true } } } } } as const;

/**
 * Registration (anti-squatting), email verification (code + registration password), login, logout,
 * session view, password reset and the admin-triggered reset code (business rules §2). Admin MFA
 * lives in MfaService.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionTokenService,
    private readonly sessionAuth: SessionAuthService,
    private readonly audit: AuditService,
    private readonly loginThrottle: LoginThrottleService,
    private readonly referrals: ReferralsService,
    private readonly otp: OtpService,
    private readonly passwords: PasswordService,
    private readonly notices: SecurityNoticesService,
  ) {}

  // ─── Registration ──────────────────────────────────────────────────────────

  /**
   * Never creates a user. Stores the pending name, password hash and validated referral code on an
   * EMAIL_VERIFICATION challenge (replacing an older pending registration for the address) and emails
   * a code. An address that already has an account gets a "someone tried to register" notice instead;
   * the response is identical either way.
   */
  async register(dto: RegisterRequest): Promise<AcceptedResponseDto> {
    const now = new Date();
    // Depends only on the code, never on the address → no enumeration. Re-validated at verification.
    const referral = dto.referralCode ? await this.referrals.resolveCodeForRegistration(this.prisma, dto.referralCode) : null;
    // Hash for every request so known and unknown addresses cost the same.
    const passwordHash = await this.passwords.hash(dto.password);

    await this.prisma.runInTransaction(async (tx) => {
      await this.otp.lock(tx, dto.email, 'EMAIL_VERIFICATION');
      const existing = await tx.user.findUnique({ where: { email: dto.email }, select: { email: true, fullName: true } });
      if (existing) {
        await this.notices.registrationAttempt(tx, existing, now);
        return;
      }
      const scope = { email: dto.email, purpose: 'EMAIL_VERIFICATION' as const };
      // A newer registration always supersedes the pending one (no cooldown), within the hourly cap.
      const decision = await this.otp.sendDecision(tx, scope, now, { enforceCooldown: false });
      if (!decision.allowed) {
        // Never leave an older pending payload verifiable after a newer registration was refused.
        await this.otp.invalidateOpen(tx, scope, now);
        this.logger.log({ reason: decision.reason }, 'Registration code not issued (limit reached)');
        return;
      }
      await this.otp.issue(
        tx,
        {
          ...scope,
          pending: { fullName: dto.fullName, passwordHash, referralCodeId: referral?.referralCodeId ?? null },
        },
        now,
      );
    });
    return accepted(ACCEPTED_MESSAGES.register);
  }

  /** New code for a pending registration (60 s cooldown, 5/hour, 24 h block — all silent). */
  async resendVerification(dto: ResendVerificationRequest): Promise<AcceptedResponseDto> {
    const now = new Date();
    await this.prisma.runInTransaction(async (tx) => {
      await this.otp.lock(tx, dto.email, 'EMAIL_VERIFICATION');
      const existing = await tx.user.findUnique({ where: { email: dto.email }, select: { id: true } });
      if (existing) return;
      const open = await tx.emailChallenge.findFirst({
        where: {
          email: dto.email,
          purpose: 'EMAIL_VERIFICATION',
          consumedAt: null,
          invalidatedAt: null,
          pendingPasswordHash: { not: null },
        },
        orderBy: { createdAt: 'desc' },
        select: { sendCount: true, pendingFullName: true, pendingPasswordHash: true, pendingReferralCodeId: true },
      });
      if (!open?.pendingFullName || !open.pendingPasswordHash) return;
      const decision = await this.otp.sendDecision(tx, { email: dto.email, purpose: 'EMAIL_VERIFICATION' }, now);
      if (!decision.allowed) return;
      await this.otp.issue(
        tx,
        {
          email: dto.email,
          purpose: 'EMAIL_VERIFICATION',
          pending: {
            fullName: open.pendingFullName,
            passwordHash: open.pendingPasswordHash,
            referralCodeId: open.pendingReferralCodeId,
          },
          sendCount: open.sendCount + 1,
        },
        now,
      );
    });
    return accepted(ACCEPTED_MESSAGES.resend);
  }

  /**
   * Verifies the code AND the password chosen at registration (argon2 against the pending hash) and,
   * in ONE transaction without savepoints: consumes the code, creates the user (ACTIVE + verified),
   * re-validates the referral code (joins without a sponsor if it is no longer valid), writes the
   * referral tree rows, grants MEMBER, creates the session and audits.
   *
   * The password check means a code from somebody else's registration for this address can never
   * activate an account with *their* password. A wrong password looks exactly like a wrong code: one
   * argon2 verification runs on every path (dummy hash when the code was wrong), the response is the
   * same `OTP_INVALID`, and the attempt — already counted by `attempt()` — stays a failed attempt
   * because the challenge is not consumed.
   */
  async verifyEmail(dto: VerifyEmailRequest, presentedToken?: string | null): Promise<SignedIn<VerifyEmailResponseDto>> {
    const now = new Date();
    const scope = { email: dto.email, purpose: 'EMAIL_VERIFICATION' as const };
    if (await this.otp.isVerificationBlocked(this.prisma, scope, now)) {
      await this.passwords.verifyDummy(dto.password);
      throw otpInvalid();
    }
    const attempt = await this.otp.attempt(scope, dto.code, now);
    const pending = attempt.ok ? attempt.challenge : null;
    // Always exactly one argon2 verification (a missing hash burns the dummy one).
    const passwordOk = await this.passwords.verify(pending?.pendingPasswordHash, dto.password);
    if (!pending || !passwordOk || !pending.pendingFullName || !pending.pendingPasswordHash) {
      await this.otp.afterFailure(scope, { notifyTo: dto.email }, now);
      throw otpInvalid();
    }
    const challenge = pending;
    const fullName = pending.pendingFullName;
    const passwordHash = pending.pendingPasswordHash;

    const userId = randomUUID();
    const ip = RequestContext.ip;
    const ua = RequestContext.userAgent;
    const outcome = await this.prisma.runInTransaction(async (tx) => {
      if (!(await this.otp.consume(tx, challenge.id, now))) throw otpInvalid();
      const taken = await tx.user.findUnique({ where: { email: challenge.email }, select: { id: true } });
      if (taken) throw otpInvalid();

      // 1. users row (the referral triggers recognise rows created by THIS transaction)
      await tx.user.create({
        data: {
          id: userId,
          email: challenge.email,
          fullName,
          passwordHash,
          passwordChangedAt: now,
          status: 'ACTIVE',
          emailVerifiedAt: now,
          lastLoginAt: now,
        },
        select: { id: true },
      });

      // 2. re-validate the referral code now that the mailbox owner has proven control
      const sponsor = await this.resolvePendingReferral(tx, challenge.pendingReferralCodeId);
      const codeNoLongerValid = challenge.pendingReferralCodeId !== null && sponsor === null;

      // 3. tree rows: shared lock → self row → relationship → ancestor rows → own code
      const attached = await this.referrals.attachNewMember(tx, {
        userId,
        sponsorUserId: sponsor?.sponsorUserId ?? null,
        referralCodeId: sponsor?.referralCodeId ?? null,
        registrationIp: ip,
        registrationUserAgent: ua,
      });

      // 4. MEMBER role, challenge → user link, session
      const memberRole = await tx.role.findUniqueOrThrow({ where: { key: 'MEMBER' }, select: { id: true } });
      await tx.userRole.create({ data: { userId, roleId: memberRole.id } });
      await tx.emailChallenge.update({ where: { id: challenge.id }, data: { userId } });
      if (presentedToken) await this.revokePresentedSession(tx, presentedToken, now);
      const session = await this.sessions.createSession(tx, {
        userId,
        ip,
        ua,
        ttlHours: this.sessions.ttlHoursFor(['MEMBER']),
      });

      await this.audit.record(tx, {
        action: 'user.register',
        resourceType: 'user',
        resourceId: userId,
        actorUserId: userId,
        actorRoles: ['MEMBER'],
        after: {
          email: challenge.email,
          sponsorUserId: sponsor?.sponsorUserId ?? null,
          referralCodeNoLongerValid: codeNoLongerValid,
          memberReferralCodeIssued: Boolean(attached.referralCode),
        },
      });
      return { session, sponsorAttached: sponsor !== null, codeNoLongerValid };
    });

    const user = await this.resolveSessionUser(outcome.session.token);
    return {
      response: {
        user,
        referral: { applied: outcome.sponsorAttached, codeNoLongerValid: outcome.codeNoLongerValid },
      },
      session: outcome.session,
    };
  }

  /** The stored referral code, re-validated (owner ACTIVE + verified, code active) — null if not usable. */
  private async resolvePendingReferral(tx: Tx, referralCodeId: string | null): Promise<ResolvedReferralCode | null> {
    if (!referralCodeId) return null;
    const row = await tx.referralCode.findUnique({ where: { id: referralCodeId }, select: { code: true } });
    if (!row) return null;
    try {
      return await this.referrals.resolveCodeForRegistration(tx, row.code);
    } catch (err) {
      if (isAppError(err) && err.code === ErrorCode.ReferralCodeInvalid) return null;
      throw err;
    }
  }

  // ─── Login / logout / session ──────────────────────────────────────────────

  /**
   * Email + password → session. Unknown email and wrong password are indistinguishable (dummy argon2,
   * same error, same throttle counters). Status errors only after a correct password. Admin-role
   * users get a session WITHOUT a second factor and `mfaRequired: true`.
   */
  async login(dto: LoginRequest, presentedToken?: string | null): Promise<SignedIn<LoginResponseDto>> {
    const now = new Date();
    const ip = RequestContext.ip;
    const emailKey = this.loginThrottle.emailKey(dto.email);
    this.loginThrottle.assertAllowed(await this.loginThrottle.check(emailKey, ip));

    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { id: true, status: true, passwordHash: true, ...ROLE_SELECT },
    });
    const passwordOk = await this.passwords.verify(user?.passwordHash, dto.password);
    if (!user || !passwordOk) {
      await this.loginThrottle.recordFailure(emailKey, ip);
      throw invalidCredentials();
    }
    await this.loginThrottle.reset(emailKey, ip);

    if (user.status === 'SUSPENDED') {
      throw new AppError(ErrorCode.AccountSuspended, 'Your account is suspended. Please contact support', 403);
    }
    if (user.status === 'DEACTIVATED') {
      throw new AppError(ErrorCode.AccountSuspended, 'This account has been deactivated. Please contact support', 403);
    }
    if (user.status !== 'ACTIVE') {
      throw new AppError(ErrorCode.EmailNotVerified, 'Verify your email address before signing in', 403);
    }

    const roles = user.roles.map((r) => r.role.key);
    const rehash = user.passwordHash && this.passwords.needsRehash(user.passwordHash) ? await this.passwords.hash(dto.password) : null;
    const session = await this.prisma.runInTransaction(async (tx) => {
      if (presentedToken) await this.revokePresentedSession(tx, presentedToken, now);
      const created = await this.sessions.createSession(tx, {
        userId: user.id,
        ip,
        ua: RequestContext.userAgent,
        ttlHours: this.sessions.ttlHoursFor(roles),
      });
      await tx.user.update({
        where: { id: user.id },
        data: { lastLoginAt: now, ...(rehash ? { passwordHash: rehash } : {}) },
        select: { id: true },
      });
      await this.audit.record(tx, {
        action: 'auth.login',
        resourceType: 'session',
        resourceId: created.sessionId,
        actorUserId: user.id,
        actorRoles: roles,
        after: { admin: roles.some(isAdminRole) },
      });
      return created;
    });

    const auth = await this.resolveAuth(session.token);
    const dtoUser = await this.toSessionUser(auth);
    const step = adminMfaStep(auth);
    return {
      response: step ? { mfaRequired: true, method: step, user: dtoUser } : { mfaRequired: false, user: dtoUser },
      session,
    };
  }

  /** Revokes the current session (or whatever session the cookie names) — always succeeds. */
  async logout(auth: AuthContext | null, presentedToken?: string | null): Promise<LogoutResponseDto> {
    const now = new Date();
    await this.prisma.runInTransaction(async (tx) => {
      if (auth) {
        await this.sessions.revokeSession(tx, auth.sessionId, 'logout');
        await this.audit.record(tx, { action: 'auth.logout', resourceType: 'session', resourceId: auth.sessionId });
      } else if (presentedToken) {
        await this.revokePresentedSession(tx, presentedToken, now, 'logout');
      }
    });
    return { signedOut: true };
  }

  async toSessionUser(auth: AuthContext, db: Db = this.prisma): Promise<SessionUserDto> {
    const profile = await db.user.findUniqueOrThrow({
      where: { id: auth.userId },
      select: { emailVerifiedAt: true, avatarUrl: true },
    });
    return toSessionUserDto(auth, profile);
  }

  /** Resolves a freshly issued (committed) token exactly like the auth guard will on the next request. */
  async resolveAuth(token: string): Promise<AuthContext> {
    const res = await this.sessionAuth.resolve(token);
    if (!res.ok) throw res.error;
    return res.auth;
  }

  async resolveSessionUser(token: string): Promise<SessionUserDto> {
    return this.toSessionUser(await this.resolveAuth(token));
  }

  /** A login/registration from a browser that still carries an older session cookie ends that session. */
  private async revokePresentedSession(tx: Db, token: string, now: Date, reason = 'superseded'): Promise<void> {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return;
    await tx.session.updateMany({
      where: { tokenHash: sha256Hex(token), revokedAt: null },
      data: { revokedAt: now, revokeReason: reason },
    });
  }

  // ─── Password reset ────────────────────────────────────────────────────────

  /**
   * Generic 202. Members get a PASSWORD_RESET code (limits silent). Self-service reset is disabled for
   * admin-role users: no email is sent and every SUPER_ADMIN is notified (once per hour) instead.
   */
  async forgotPassword(dto: ForgotPasswordRequest): Promise<AcceptedResponseDto> {
    const now = new Date();
    await this.prisma.runInTransaction(async (tx) => {
      await this.otp.lock(tx, dto.email, 'PASSWORD_RESET');
      const user = await tx.user.findUnique({
        where: { email: dto.email },
        select: { id: true, email: true, status: true, ...ROLE_SELECT },
      });
      if (!user || user.status !== 'ACTIVE') return;
      if (user.roles.some((r) => isAdminRole(r.role.key))) {
        await this.notices.notifySuperAdmins(tx, {
          subjectUserId: user.id,
          title: 'Password reset requested for an admin account',
          paragraphs: [
            `Someone requested a self-service password reset for the admin account ${maskEmail(user.email)}.`,
            'Self-service resets are disabled for administrative roles, so no code was sent.',
            'If the owner needs a new password, a Super Admin can trigger an audited reset. If nobody asked, this may be an attempt to take over the account.',
          ],
          dedupeKey: `admin-reset:${user.id}:${hourBucket(now)}`,
        });
        await this.audit.record(tx, {
          action: 'auth.password_reset.blocked_admin',
          resourceType: 'user',
          resourceId: user.id,
          actorUserId: null,
        });
        return;
      }
      const decision = await this.otp.sendDecision(tx, { email: dto.email, purpose: 'PASSWORD_RESET' }, now);
      if (!decision.allowed) return;
      await this.otp.issue(tx, { email: dto.email, purpose: 'PASSWORD_RESET', userId: user.id }, now);
    });
    return accepted(ACCEPTED_MESSAGES.forgot);
  }

  /**
   * Admin-triggered reset (used by `AdminMembersService.sendPasswordReset` — SUPER_ADMIN, audited
   * there): issues a PASSWORD_RESET code to the account's current address, also for admin-role
   * accounts whose self-service reset is disabled, and tells the owner (email + in-app) that an
   * administrator started it. The challenge records the issuing SUPER_ADMIN session in `session_id`;
   * that is what lets `resetPassword` accept the code for an admin-role account.
   *
   * Runs inside the caller's transaction (advisory lock per address + purpose). The code limits apply
   * with explicit 429s — the caller is an authenticated admin, so there is nothing to enumerate.
   * Revoking the member's sessions, auditing and notifying the SUPER_ADMINs is the caller's job.
   */
  async issueAdminPasswordReset(
    tx: Tx,
    input: { user: { id: string; email: string; fullName: string }; issuedBySessionId: string },
    now: Date,
  ): Promise<IssuedChallenge> {
    const { user } = input;
    const scope = { email: user.email, purpose: 'PASSWORD_RESET' as const, userId: user.id };
    await this.otp.lock(tx, user.email, 'PASSWORD_RESET');
    const decision = await this.otp.sendDecision(tx, scope, now);
    if (!decision.allowed) throw otpSendRefused(decision);
    const issued = await this.otp.issue(tx, { ...scope, sessionId: input.issuedBySessionId }, now);
    await this.notices.adminPasswordResetStarted(tx, user);
    return issued;
  }

  /**
   * The SUPER_ADMIN behind an admin-triggered reset code: the user of the session recorded on the
   * challenge, if that user is still an ACTIVE SUPER_ADMIN other than the account being reset.
   * Null for self-service codes (no session) or when the issuer lost the role/was suspended meanwhile.
   */
  private async adminResetIssuer(db: Db, sessionId: string | null, subjectUserId: string): Promise<string | null> {
    if (!sessionId) return null;
    const session = await db.session.findUnique({
      where: { id: sessionId },
      select: { userId: true, user: { select: { status: true, ...ROLE_SELECT } } },
    });
    if (!session || session.userId === subjectUserId || session.user.status !== 'ACTIVE') return null;
    return session.user.roles.some((r) => r.role.key === 'SUPER_ADMIN') ? session.userId : null;
  }

  /**
   * Code + new password → new hash, every session revoked, owner notified. Does not sign in.
   * Admin-role accounts can only use a code a SUPER_ADMIN issued (`issueAdminPasswordReset`).
   */
  async resetPassword(dto: ResetPasswordRequest): Promise<PasswordResetResponseDto> {
    const now = new Date();
    const scope = { email: dto.email, purpose: 'PASSWORD_RESET' as const };
    if (await this.otp.isVerificationBlocked(this.prisma, scope, now)) throw otpInvalid();
    const attempt = await this.otp.attempt(scope, dto.code, now);
    if (!attempt.ok) {
      const owner = await this.prisma.user.findUnique({ where: { email: dto.email }, select: { fullName: true } });
      if (owner) await this.otp.afterFailure(scope, { notifyTo: dto.email, name: owner.fullName }, now);
      throw otpInvalid();
    }
    const challenge = attempt.challenge;
    const newHash = await this.passwords.hash(dto.newPassword);

    const applied = await this.prisma.runInTransaction(async (tx) => {
      if (!(await this.otp.consume(tx, challenge.id, now))) return false;
      const user = challenge.userId
        ? await tx.user.findUnique({
            where: { id: challenge.userId },
            select: { id: true, email: true, fullName: true, status: true, ...ROLE_SELECT },
          })
        : null;
      // The code stays consumed even when the reset is refused (address changed, suspended, an admin
      // account with a self-service code).
      if (!user || user.email !== challenge.email || user.status !== 'ACTIVE') return false;
      const roles = user.roles.map((r) => r.role.key);
      const adminAccount = roles.some(isAdminRole);
      const issuedBy = await this.adminResetIssuer(tx, challenge.sessionId, user.id);
      if (adminAccount && !issuedBy) return false;

      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash: newHash, passwordChangedAt: now },
        select: { id: true },
      });
      await this.sessions.revokeAllForUser(tx, user.id, 'password_reset');
      await this.otp.invalidateOpen(tx, { userId: user.id, purpose: 'PASSWORD_RESET' }, now);
      await this.audit.record(tx, {
        action: 'user.password.reset',
        resourceType: 'user',
        resourceId: user.id,
        actorUserId: user.id,
        actorRoles: roles,
        ...(issuedBy ? { after: { adminInitiated: true, initiatedByUserId: issuedBy } } : {}),
      });
      await this.notices.passwordChanged(tx, user, 'reset');
      if (adminAccount) {
        await this.notices.notifySuperAdmins(tx, {
          subjectUserId: user.id,
          title: 'Admin account password reset completed',
          paragraphs: [
            `The admin account ${maskEmail(user.email)} set a new password with the reset code a Super Admin sent. All of its sessions were signed out.`,
          ],
        });
      }
      return true;
    });
    if (!applied) throw otpInvalid();
    await this.loginThrottle.reset(this.loginThrottle.emailKey(dto.email), RequestContext.ip);
    return { passwordReset: true };
  }
}
