import { Injectable } from '@nestjs/common';
import { ErrorCode, isAdminRole, type MfaMethod, type UserStatus } from '@app/shared';
import type { Response } from 'express';
import { AppConfig } from '../../config/app-config';
import { randomToken, sha256Hex } from '../crypto/tokens';
import { AppError, unauthenticated } from '../errors/app-error';
import type { Db } from '../prisma/prisma.service';
import { ADMIN_MFA_MAX_AGE_MS } from './auth-context';
import { clearCsrfCookie, clearSessionCookie, setCsrfCookie, setSessionCookie } from './cookies';

/**
 * What the caller verified before creating a session (e.g. the password hash a login checked the
 * password against). `createSession` re-reads the users row under `FOR SHARE` and refuses when it no
 * longer matches — a password reset/change or suspension that committed in between wins.
 */
export interface SessionCredentialExpectation {
  status: UserStatus;
  passwordHash: string | null;
}

export interface CreateSessionInput {
  userId: string;
  ip?: string | null;
  ua?: string | null;
  /** Absolute lifetime. Use `ttlHoursFor(roles)` to pick member vs admin TTL. */
  ttlHours: number;
  /** Required for sign-ins (login, registration); omitted only by tests/tools that mint sessions. */
  expect?: SessionCredentialExpectation;
}

/** The credentials changed while the session was being created (same answer as a wrong password). */
export const staleCredentials = () => new AppError(ErrorCode.InvalidCredentials, 'Incorrect email or password', 401);

interface UserLockRow {
  status: UserStatus;
  password_hash: string | null;
}

export interface CreatedSession {
  /** Raw opaque token — goes ONLY into the cookie, never into logs or the DB. */
  token: string;
  sessionId: string;
  expiresAt: Date;
}

/** Session revoke reasons stored in sessions.revoke_reason (≤ 64 chars). */
export type SessionRevokeReason =
  | 'logout'
  | 'mfa_rotated'
  | 'password_changed'
  | 'password_reset'
  | 'email_changed'
  | 'suspended'
  | 'deactivated'
  | 'idle_timeout'
  | 'admin_revoked'
  | 'roles_changed'
  | 'mfa_reset'
  | (string & {});

/**
 * Session primitives shared by the auth slice (login/logout/MFA) and others (suspension, role changes,
 * password change). Only SHA-256(token) is persisted. Sessions are created WITHOUT a second factor;
 * completing MFA rotates the token (`elevateSession`).
 *
 * Race-safety with credential changes (business rules §2 "Sessions"): `createSession` and
 * `elevateSession` hold the users row `FOR SHARE` while they insert the new session, and
 * `revokeAllForUser` takes it `FOR NO KEY UPDATE` before revoking. The two lock modes conflict, so a
 * session is either committed before the revocation statement runs (and is revoked by it) or is
 * created after the credential change committed (and is refused: changed hash/status, or the old
 * session is already revoked). Callers that also UPDATE the users row must do so BEFORE creating the
 * session in the same transaction (upgrading a shared lock would deadlock two concurrent sign-ins).
 */
@Injectable()
export class SessionTokenService {
  constructor(private readonly config: AppConfig) {}

  static hashToken(token: string): string {
    return sha256Hex(token);
  }

  /** Member TTL (SESSION_TTL_HOURS) or admin TTL (ADMIN_SESSION_TTL_HOURS) if any admin role. */
  ttlHoursFor(roles: readonly string[]): number {
    return roles.some(isAdminRole) ? this.config.security.adminSessionTtlHours : this.config.security.sessionTtlHours;
  }

  /** `SELECT … FOR SHARE` on the users row (null when the user does not exist). */
  private async shareLockUser(tx: Db, userId: string): Promise<UserLockRow | null> {
    const rows = await tx.$queryRaw<UserLockRow[]>`
      SELECT "status"::text AS "status", "password_hash" FROM "users" WHERE "id" = ${userId}::uuid FOR SHARE`;
    return rows[0] ?? null;
  }

  /**
   * New session (no MFA). Returns the raw token for the cookie. With `expect`, refuses (401
   * INVALID_CREDENTIALS) when the account's status or password hash is no longer what the caller
   * verified — e.g. a password reset committed while a login was checking the old password.
   */
  async createSession(tx: Db, input: CreateSessionInput): Promise<CreatedSession> {
    const locked = await this.shareLockUser(tx, input.userId);
    if (input.expect && (!locked || locked.status !== input.expect.status || locked.password_hash !== input.expect.passwordHash)) {
      throw staleCredentials();
    }
    const token = randomToken(32);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.ttlHours * 3_600_000);
    const session = await tx.session.create({
      data: {
        userId: input.userId,
        tokenHash: sha256Hex(token),
        ipAddress: input.ip?.slice(0, 64) ?? null,
        userAgent: input.ua?.slice(0, 512) ?? null,
        createdAt: now,
        lastSeenAt: now,
        expiresAt,
      },
      select: { id: true },
    });
    return { token, sessionId: session.id, expiresAt };
  }

  /**
   * Records a completed second factor by ROTATING the session (business rules §2): a new session row
   * with `mfaVerifiedAt = now`, `mfaMethod = method` and `expiresAt = least(old.expiresAt, now + 12 h)`
   * is created and the old row is revoked with reason `mfa_rotated`. Returns the NEW raw token — set
   * it as the cookie (`setSessionCookie`). Run it in the transaction that consumes the challenge /
   * accepts the TOTP code. Throws 401 when the old session is missing, revoked or expired (also when
   * two elevations race: only one wins), or when the account is no longer ACTIVE.
   *
   * The users row is held `FOR SHARE` before the old session is checked, so a concurrent
   * `revokeAllForUser` (password change/reset, suspension, role change…) either waits for this
   * elevation and then revokes the NEW session too, or commits first — and the old session is then
   * already revoked, which fails the elevation.
   */
  async elevateSession(tx: Db, oldSessionId: string, method: MfaMethod): Promise<CreatedSession> {
    const expired = () => unauthenticated('Your session has expired. Please sign in again');
    const owner = await tx.session.findUnique({ where: { id: oldSessionId }, select: { userId: true } });
    if (!owner) throw expired();
    const user = await this.shareLockUser(tx, owner.userId);
    if (!user || user.status !== 'ACTIVE') throw expired();
    const now = new Date();
    // Re-read AFTER the lock (READ COMMITTED: a revocation committed meanwhile is visible now).
    const old = await tx.session.findUnique({
      where: { id: oldSessionId },
      select: { id: true, userId: true, ipAddress: true, userAgent: true, expiresAt: true, revokedAt: true },
    });
    if (!old || old.revokedAt || old.expiresAt.getTime() <= now.getTime()) {
      throw expired();
    }
    // The conditional revoke row-locks the old session: a concurrent elevation blocks here and then
    // matches no row.
    const revoked = await tx.session.updateMany({
      where: { id: old.id, revokedAt: null },
      data: { revokedAt: now, revokeReason: 'mfa_rotated' },
    });
    if (revoked.count !== 1) throw expired();

    const token = randomToken(32);
    const expiresAt = new Date(Math.min(old.expiresAt.getTime(), now.getTime() + ADMIN_MFA_MAX_AGE_MS));
    const created = await tx.session.create({
      data: {
        userId: old.userId,
        tokenHash: sha256Hex(token),
        mfaVerifiedAt: now,
        mfaMethod: method,
        ipAddress: old.ipAddress,
        userAgent: old.userAgent,
        createdAt: now,
        lastSeenAt: now,
        expiresAt,
      },
      select: { id: true },
    });
    return { token, sessionId: created.id, expiresAt };
  }

  async revokeSession(tx: Db, sessionId: string, reason: SessionRevokeReason): Promise<void> {
    await tx.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason.slice(0, 64) },
    });
  }

  /**
   * Revokes every open session of a user — on password change/reset, suspension, deactivation and ANY
   * role grant/revoke (business rules §2). `exceptSessionId` keeps the current one (e.g. password
   * change from that session). Returns the count.
   *
   * Locks the users row first (`FOR NO KEY UPDATE`: conflicts with the `FOR SHARE` that
   * `createSession`/`elevateSession` hold, but not with FK key-share locks), so a session being
   * created concurrently is committed — and revoked here — before this statement runs.
   */
  async revokeAllForUser(
    tx: Db,
    userId: string,
    reason: SessionRevokeReason,
    options: { exceptSessionId?: string } = {},
  ): Promise<number> {
    await tx.$queryRaw`SELECT 1 FROM "users" WHERE "id" = ${userId}::uuid FOR NO KEY UPDATE`;
    const res = await tx.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(options.exceptSessionId ? { id: { not: options.exceptSessionId } } : {}),
      },
      data: { revokedAt: new Date(), revokeReason: reason.slice(0, 64) },
    });
    return res.count;
  }

  setSessionCookie(res: Response, token: string, expires: Date): void {
    setSessionCookie(res, token, expires, { secure: this.config.security.cookieSecure });
  }

  clearSessionCookie(res: Response): void {
    clearSessionCookie(res, { secure: this.config.security.cookieSecure });
  }

  /** Issues a fresh CSRF double-submit token cookie and returns the token (send it in `x-csrf-token`). */
  issueCsrfToken(res: Response): string {
    const token = randomToken(32);
    setCsrfCookie(res, token, { secure: this.config.security.cookieSecure });
    return token;
  }

  clearCsrfCookie(res: Response): void {
    clearCsrfCookie(res, { secure: this.config.security.cookieSecure });
  }
}
