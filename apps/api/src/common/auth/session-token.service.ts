import { Injectable } from '@nestjs/common';
import { isAdminRole } from '@app/shared';
import type { Response } from 'express';
import { AppConfig } from '../../config/app-config';
import { randomToken, sha256Hex } from '../crypto/tokens';
import type { Db } from '../prisma/prisma.service';
import { clearCsrfCookie, clearSessionCookie, setCsrfCookie, setSessionCookie } from './cookies';

export interface CreateSessionInput {
  userId: string;
  mfaVerified: boolean;
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
  | 'password_changed'
  | 'password_reset'
  | 'suspended'
  | 'deactivated'
  | 'idle_timeout'
  | 'admin_revoked'
  | 'roles_changed'
  | (string & {});

/**
 * Session primitives shared by the auth slice (login/logout/MFA) and others (suspension, password
 * change). Only SHA-256(token) is persisted.
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

  async createSession(tx: Db, input: CreateSessionInput): Promise<CreatedSession> {
    const token = randomToken(32);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.ttlHours * 3_600_000);
    const session = await tx.session.create({
      data: {
        userId: input.userId,
        tokenHash: sha256Hex(token),
        mfaVerified: input.mfaVerified,
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

  /** Marks the session as having completed the email-OTP second factor. */
  async markMfaVerified(tx: Db, sessionId: string): Promise<void> {
    await tx.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { mfaVerified: true } });
  }

  async revokeSession(tx: Db, sessionId: string, reason: SessionRevokeReason): Promise<void> {
    await tx.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason.slice(0, 64) },
    });
  }

  /** Revokes every open session of a user (optionally keeping the current one). Returns the count. */
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
