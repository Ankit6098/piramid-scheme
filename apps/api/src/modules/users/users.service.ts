import { Injectable } from '@nestjs/common';
import {
  isAdminRole,
  MfaRequiredReason,
  type AcceptedResponseDto,
  type ActivityEntryDto,
  type ApiPage,
  type ChangePasswordRequest,
  type ConfirmEmailChangeRequest,
  type CursorPageQuery,
  type ProfileDto,
  type RevokeSessionResponseDto,
  type RevokeSessionsResponseDto,
  type StartEmailChangeRequest,
  type UpdateProfileRequest,
  type UserSessionDto,
} from '@app/shared';
import { z } from 'zod';
import type { AuthContext } from '../../common/auth/auth-context';
import { SessionTokenService } from '../../common/auth/session-token.service';
import { AuditService } from '../../common/audit/audit.service';
import { maskEmail } from '../../common/audit/mask';
import { RequestContext } from '../../common/context/request-context';
import { conflict, mfaRequired, notFound, validationFailed } from '../../common/errors/app-error';
import { decodeCursor, paginate } from '../../common/pagination/cursor';
import { keysetWhere } from '../../common/pagination/keyset';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService, type Db, type Tx } from '../../common/prisma/prisma.service';
import { LoginThrottleService } from '../../common/throttle/login-throttle.service';
import { AppConfig } from '../../config/app-config';
import { ACCEPTED_MESSAGES, accepted, otpInvalid } from '../auth/auth-errors';
import { MfaService } from '../auth/mfa.service';
import { OtpService } from '../auth/otp.service';
import { PasswordService } from '../auth/password.service';
import { SecurityNoticesService } from '../auth/security-notices.service';
import { diffProfile, toActivityDto, toProfileDto, toUserSessionDto } from './domain/profile';

const keysetCursor = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });

const PROFILE_SELECT = {
  id: true,
  fullName: true,
  email: true,
  emailVerifiedAt: true,
  phone: true,
  avatarUrl: true,
  createdAt: true,
  lastLoginAt: true,
  passwordChangedAt: true,
  roles: { select: { role: { select: { key: true } } } },
  mfaFactors: {
    where: { kind: 'TOTP' as const, revokedAt: null, confirmedAt: { not: null } },
    select: { confirmedAt: true },
    take: 1,
  },
} as const;

/**
 * Self-service profile & security for the signed-in user (/users/me/*). Every use case acts only on
 * `auth.userId`; nothing here can read or change another account.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
    private readonly sessions: SessionTokenService,
    private readonly loginThrottle: LoginThrottleService,
    private readonly passwords: PasswordService,
    private readonly otp: OtpService,
    private readonly notices: SecurityNoticesService,
    private readonly mfa: MfaService,
  ) {}

  // ─── Profile ───────────────────────────────────────────────────────────────

  async getProfile(auth: AuthContext, db: Db = this.prisma): Promise<ProfileDto> {
    const row = await db.user.findUniqueOrThrow({ where: { id: auth.userId }, select: PROFILE_SELECT });
    return toProfileDto(row);
  }

  async updateProfile(auth: AuthContext, dto: UpdateProfileRequest): Promise<ProfileDto> {
    return this.prisma.runInTransaction(async (tx) => {
      const current = await tx.user.findUniqueOrThrow({
        where: { id: auth.userId },
        select: { fullName: true, phone: true, avatarUrl: true },
      });
      const { changed, before } = diffProfile(current, dto);
      if (Object.keys(changed).length > 0) {
        await tx.user.update({ where: { id: auth.userId }, data: changed, select: { id: true } });
        await this.audit.record(tx, {
          action: 'user.profile.update',
          resourceType: 'user',
          resourceId: auth.userId,
          before,
          after: changed,
        });
      }
      return this.getProfile(auth, tx);
    });
  }

  // ─── Password ──────────────────────────────────────────────────────────────

  /**
   * Current password required (throttled like a login); revokes every OTHER session. The update is
   * conditional on the hash that was verified (and on this session still being open), so a password
   * reset that committed meanwhile is never overwritten with a password chosen from the old one.
   */
  async changePassword(auth: AuthContext, dto: ChangePasswordRequest): Promise<ProfileDto> {
    const verifiedHash = await this.verifyCurrentPassword(auth, dto.currentPassword, 'currentPassword');
    const newHash = await this.passwords.hash(dto.newPassword);
    const now = new Date();
    return this.prisma.runInTransaction(async (tx) => {
      const updated = await tx.user.updateMany({
        where: { id: auth.userId, passwordHash: verifiedHash, status: 'ACTIVE' },
        data: { passwordHash: newHash, passwordChangedAt: now },
      });
      if (updated.count !== 1 || !(await this.isSessionOpen(tx, auth.sessionId))) throw incorrectPassword('currentPassword');
      const user = await tx.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { id: true, email: true, fullName: true } });
      await this.sessions.revokeAllForUser(tx, auth.userId, 'password_changed', { exceptSessionId: auth.sessionId });
      await this.otp.invalidateOpen(tx, { userId: auth.userId, purpose: 'PASSWORD_RESET' }, now);
      await this.audit.record(tx, { action: 'user.password.change', resourceType: 'user', resourceId: auth.userId });
      await this.notices.passwordChanged(tx, user, 'changed');
      if (auth.isAdmin) {
        await this.notices.notifySuperAdmins(tx, {
          subjectUserId: auth.userId,
          title: 'Admin account password changed',
          paragraphs: [`The admin account ${maskEmail(user.email)} changed its password. Its other sessions were signed out.`],
        });
      }
      return this.getProfile(auth, tx);
    });
  }

  // ─── Email change ──────────────────────────────────────────────────────────

  /**
   * Password required. Sends an EMAIL_CHANGE code to the NEW address. If that address belongs to
   * another account, it gets a notice instead — the response (and the audit entry) is identical.
   *
   * Admin-role accounts additionally need a TOTP-verified session (`adminAccess`): the mailbox is
   * where a first admin sign-in's LOGIN_MFA code goes, so a password alone must never move it.
   */
  async startEmailChange(auth: AuthContext, dto: StartEmailChangeRequest): Promise<AcceptedResponseDto> {
    this.assertAdminStepUp(auth);
    if (dto.newEmail === auth.email) {
      throw validationFailed('This is already your email address', {
        issues: [{ path: 'newEmail', message: 'This is already your email address', code: 'custom' }],
      });
    }
    await this.verifyCurrentPassword(auth, dto.password, 'password');
    const now = new Date();
    await this.prisma.runInTransaction(async (tx) => {
      await this.otp.lock(tx, dto.newEmail, 'EMAIL_CHANGE');
      await this.audit.record(tx, {
        action: 'user.email_change.requested',
        resourceType: 'user',
        resourceId: auth.userId,
        after: { newEmail: dto.newEmail },
      });
      const taken = await tx.user.findUnique({ where: { email: dto.newEmail }, select: { fullName: true } });
      if (taken) {
        await this.notices.emailChangeTargetTaken(tx, { to: dto.newEmail, name: taken.fullName }, now);
        return;
      }
      const decision = await this.otp.sendDecision(
        tx,
        { email: dto.newEmail, purpose: 'EMAIL_CHANGE', userId: auth.userId },
        now,
      );
      if (!decision.allowed) return;
      // One pending change per account: close any older one (possibly to another address).
      await this.otp.invalidateOpen(tx, { userId: auth.userId, purpose: 'EMAIL_CHANGE' }, now);
      await this.otp.issue(tx, { email: dto.newEmail, purpose: 'EMAIL_CHANGE', userId: auth.userId }, now);
    });
    return accepted(ACCEPTED_MESSAGES.emailChange);
  }

  /**
   * Code from the new mailbox → address changed, other sessions revoked, OLD address notified.
   * Admin-role accounts need `adminAccess` here too (a change started as a member, or before the
   * TOTP verification expired, cannot be finished without it).
   */
  async confirmEmailChange(auth: AuthContext, dto: ConfirmEmailChangeRequest): Promise<ProfileDto> {
    this.assertAdminStepUp(auth);
    const now = new Date();
    const open = await this.prisma.emailChallenge.findFirst({
      where: { userId: auth.userId, purpose: 'EMAIL_CHANGE', consumedAt: null, invalidatedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { email: true },
    });
    if (!open) throw otpInvalid();
    const history = { email: open.email, purpose: 'EMAIL_CHANGE' as const, userId: auth.userId };
    if (await this.otp.isVerificationBlocked(this.prisma, history, now)) throw otpInvalid();
    const attempt = await this.otp.attempt({ purpose: 'EMAIL_CHANGE', userId: auth.userId }, dto.code, now);
    if (!attempt.ok) {
      await this.otp.afterFailure(history, { notifyTo: auth.email, name: auth.fullName }, now);
      throw otpInvalid();
    }
    const newEmail = attempt.challenge.email;

    return this.prisma.runInTransaction(async (tx) => {
      if (!(await this.otp.consume(tx, attempt.challenge.id, now))) throw otpInvalid();
      // Admin status as of NOW (a role granted since the request started counts too), under the lock
      // that revokeAllForUser/role changes take.
      await this.lockUser(tx, auth.userId);
      if (!auth.adminAccess && (await this.holdsAdminRole(tx, auth.userId))) throw this.stepUpRequired(auth);
      const before = await tx.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { email: true, fullName: true } });
      const taken = await tx.user.findUnique({ where: { email: newEmail }, select: { id: true } });
      if (taken) throw conflict('This email address is no longer available');
      await tx.user.update({
        where: { id: auth.userId },
        data: { email: newEmail, emailVerifiedAt: now },
        select: { id: true },
      });
      await this.sessions.revokeAllForUser(tx, auth.userId, 'email_changed', { exceptSessionId: auth.sessionId });
      // Codes addressed to the old address (password reset, MFA) are void now.
      await tx.emailChallenge.updateMany({
        where: { userId: auth.userId, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: now },
      });
      await this.audit.record(tx, {
        action: 'user.email.change',
        resourceType: 'user',
        resourceId: auth.userId,
        before: { email: before.email },
        after: { email: newEmail },
      });
      await this.notices.emailChanged(tx, { userId: auth.userId, oldEmail: before.email, newEmail, name: before.fullName });
      if (auth.isAdmin) {
        await this.notices.notifySuperAdmins(tx, {
          subjectUserId: auth.userId,
          title: 'Admin account email changed',
          paragraphs: [
            `The admin account ${maskEmail(before.email)} changed its sign-in email to ${maskEmail(newEmail)}. Its other sessions were signed out.`,
          ],
        });
      }
      return this.getProfile(auth, tx);
    });
  }

  // ─── Sessions ──────────────────────────────────────────────────────────────

  /** Open sessions of the caller (not revoked, not expired, not idle), newest first. */
  async listSessions(auth: AuthContext, query: CursorPageQuery): Promise<ApiPage<UserSessionDto>> {
    const now = new Date();
    const c = decodeCursor(query.cursor, keysetCursor);
    const idleCutoff = new Date(now.getTime() - this.config.security.sessionIdleTimeoutMinutes * 60_000);
    const rows = await this.prisma.session.findMany({
      where: {
        userId: auth.userId,
        revokedAt: null,
        expiresAt: { gt: now },
        lastSeenAt: { gt: idleCutoff },
        ...(c ? keysetWhere<Prisma.SessionWhereInput>('createdAt', new Date(c.createdAt), c.id, 'desc') : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: { id: true, createdAt: true, lastSeenAt: true, expiresAt: true, ipAddress: true, userAgent: true, mfaMethod: true },
    });
    return paginate(
      rows,
      query.limit,
      (r) => ({ createdAt: r.createdAt.toISOString(), id: r.id }),
      (r) => toUserSessionDto(r, auth.sessionId),
    );
  }

  /** Revokes one of the caller's own sessions (404 for anyone else's). Revoking the current one signs out. */
  async revokeSession(auth: AuthContext, sessionId: string): Promise<RevokeSessionResponseDto> {
    return this.prisma.runInTransaction(async (tx) => {
      const session = await tx.session.findFirst({
        where: { id: sessionId, userId: auth.userId },
        select: { id: true, revokedAt: true },
      });
      if (!session) throw notFound('Session');
      if (!session.revokedAt) {
        await this.sessions.revokeSession(tx, session.id, 'user_revoked');
        await this.audit.record(tx, { action: 'user.session.revoke', resourceType: 'session', resourceId: session.id });
      }
      return { revoked: true, current: session.id === auth.sessionId };
    });
  }

  async revokeOtherSessions(auth: AuthContext): Promise<RevokeSessionsResponseDto> {
    return this.prisma.runInTransaction(async (tx) => {
      const revoked = await this.sessions.revokeAllForUser(tx, auth.userId, 'user_revoked_others', {
        exceptSessionId: auth.sessionId,
      });
      await this.audit.record(tx, {
        action: 'user.sessions.revoke_others',
        resourceType: 'user',
        resourceId: auth.userId,
        after: { revoked },
      });
      return { revoked };
    });
  }

  // ─── Activity ──────────────────────────────────────────────────────────────

  /** The caller's own audit trail: actions they performed and changes to their own account. */
  async listActivity(auth: AuthContext, query: CursorPageQuery): Promise<ApiPage<ActivityEntryDto>> {
    const c = decodeCursor(query.cursor, keysetCursor);
    const rows = await this.prisma.auditLog.findMany({
      where: {
        AND: [
          { OR: [{ actorUserId: auth.userId }, { resourceType: 'user', resourceId: auth.userId }] },
          ...(c ? [keysetWhere<Prisma.AuditLogWhereInput>('createdAt', new Date(c.createdAt), c.id, 'desc')] : []),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: { id: true, action: true, resourceType: true, createdAt: true, ipAddress: true },
    });
    return paginate(rows, query.limit, (r) => ({ createdAt: r.createdAt.toISOString(), id: r.id }), toActivityDto);
  }

  // ─── Authenticator reset (admins) ──────────────────────────────────────────

  async resetTotp(auth: AuthContext, code: string): Promise<ProfileDto> {
    await this.mfa.resetTotp(auth, code);
    return this.getProfile(auth);
  }

  // ─── helpers ───────────────────────────────────────────────────────────────

  /**
   * Re-authentication for sensitive changes. Failures share the login backoff (per email + IP), so a
   * stolen session cannot brute-force the password. A wrong password is a field error (400), not a
   * 401 — the session itself is fine. Returns the hash that was verified (for conditional updates).
   */
  private async verifyCurrentPassword(auth: AuthContext, password: string, field: string): Promise<string> {
    const ip = RequestContext.ip;
    const key = this.loginThrottle.emailKey(auth.email);
    this.loginThrottle.assertAllowed(await this.loginThrottle.check(key, ip));
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { passwordHash: true } });
    if (!(await this.passwords.verify(user.passwordHash, password)) || !user.passwordHash) {
      await this.loginThrottle.recordFailure(key, ip);
      throw incorrectPassword(field);
    }
    await this.loginThrottle.reset(key, ip);
    return user.passwordHash;
  }

  /**
   * Admin-role accounts may move their sign-in mailbox only from a TOTP-verified session (business
   * rules §2 "Admin MFA"): otherwise a password alone would redirect the LOGIN_MFA code that
   * bootstraps the authenticator enrollment.
   */
  private assertAdminStepUp(auth: AuthContext): void {
    if (auth.isAdmin && !auth.adminAccess) throw this.stepUpRequired(auth);
  }

  private stepUpRequired(auth: AuthContext) {
    return mfaRequired('Verify with your authenticator app before changing the email address of an administrator account', {
      reason: auth.hasTotpFactor ? MfaRequiredReason.TotpRequired : MfaRequiredReason.TotpEnrollmentRequired,
    });
  }

  private async lockUser(tx: Tx, userId: string): Promise<void> {
    await tx.$queryRaw`SELECT 1 FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE`;
  }

  private async holdsAdminRole(db: Db, userId: string): Promise<boolean> {
    const roles = await db.userRole.findMany({ where: { userId }, select: { role: { select: { key: true } } } });
    return roles.some((r) => isAdminRole(r.role.key));
  }

  private async isSessionOpen(db: Db, sessionId: string): Promise<boolean> {
    return (await db.session.count({ where: { id: sessionId, revokedAt: null, expiresAt: { gt: new Date() } } })) === 1;
  }
}

function incorrectPassword(field: string) {
  return validationFailed('The password is incorrect', {
    issues: [{ path: field, message: 'The password is incorrect', code: 'custom' }],
  });
}
