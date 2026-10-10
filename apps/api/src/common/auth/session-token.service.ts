import { Injectable } from '@nestjs/common';
import { isAdminRole, type MfaMethod } from '@app/shared';
import type { Response } from 'express';
import { AppConfig } from '../../config/app-config';
import { randomToken, sha256Hex } from '../crypto/tokens';
import { unauthenticated } from '../errors/app-error';
import type { Db } from '../prisma/prisma.service';
import { ADMIN_MFA_MAX_AGE_MS } from './auth-context';
import { clearCsrfCookie, clearSessionCookie, setCsrfCookie, setSessionCookie } from './cookies';

export interface CreateSessionInput {
  userId: string;
  ip?: string | null;
  ua?: string | null;
  /** Absolute lifetime. Use `ttlHoursFor(roles)` to pick member vs admin TTL. */
  ttlHours: number;
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

  /** New session (no MFA). Returns the raw token for the cookie. */
  async createSession(tx: Db, input: CreateSessionInput): Promise<CreatedSession> {
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
   * two elevations race: only one wins).
   */
  async elevateSession(tx: Db, oldSessionId: string, method: MfaMethod): Promise<CreatedSession> {
    const now = new Date();
    const old = await tx.session.findUnique({
      where: { id: oldSessionId },
      select: { id: true, userId: true, ipAddress: true, userAgent: true, expiresAt: true, revokedAt: true },
    });
    if (!old || old.revokedAt || old.expiresAt.getTime() <= now.getTime()) {
      throw unauthenticated('Your session has expired. Please sign in again');
    }
    // The conditional revoke row-locks the old session: a concurrent elevation blocks here and then
    // matches no row.
    const revoked = await tx.session.updateMany({
      where: { id: old.id, revokedAt: null },
      data: { revokedAt: now, revokeReason: 'mfa_rotated' },
    });
    if (revoked.count !== 1) throw unauthenticated('Your session has expired. Please sign in again');

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
   */
  async revokeAllForUser(
    tx: Db,
    userId: string,
    reason: SessionRevokeReason,
    options: { exceptSessionId?: string } = {},
  ): Promise<number> {
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
