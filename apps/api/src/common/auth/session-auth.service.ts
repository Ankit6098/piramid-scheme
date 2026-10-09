import { Injectable, Logger } from '@nestjs/common';
import { ErrorCode, isAdminRole, type Permission, type RoleKey, RoleKey as RoleKeys } from '@app/shared';
import { AppConfig } from '../../config/app-config';
import { sha256Hex } from '../crypto/tokens';
import { AppError, unauthenticated } from '../errors/app-error';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthContext } from './auth-context';

/** lastSeenAt is refreshed at most this often per session. */
export const LAST_SEEN_UPDATE_INTERVAL_MS = 5 * 60_000;

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

export type SessionResolution =
  | { ok: true; auth: AuthContext }
  | { ok: false; error: AppError; /** the cookie is dead and should be cleared */ clearCookie: boolean };

/**
 * Resolves an opaque session token (cookie `sid`) into an AuthContext:
 * sha256 → sessions row; rejects revoked, expired (absolute) and idle-expired sessions; requires the
 * user to be ACTIVE (SUSPENDED → 403 ACCOUNT_SUSPENDED, others → 401); loads roles, permissions and
 * program scopes; refreshes lastSeenAt at most every 5 minutes.
 */
@Injectable()
export class SessionAuthService {
  private readonly logger = new Logger(SessionAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  async resolve(rawToken: string | undefined | null, now: Date = new Date()): Promise<SessionResolution> {
    if (!rawToken) return { ok: false, error: unauthenticated(), clearCookie: false };
    if (!TOKEN_RE.test(rawToken)) return { ok: false, error: unauthenticated(), clearCookie: true };

    const session = await this.prisma.session.findUnique({
      where: { tokenHash: sha256Hex(rawToken) },
      select: {
        id: true,
        mfaVerified: true,
        expiresAt: true,
        lastSeenAt: true,
        revokedAt: true,
        user: {
          select: {
            id: true,
            email: true,
            fullName: true,
            status: true,
            roles: {
              select: {
                role: { select: { key: true, permissions: { select: { permission: { select: { key: true } } } } } },
              },
            },
            programAssignments: { select: { programId: true } },
          },
        },
      },
    });

    const expired = unauthenticated('Your session has expired. Please sign in again');
    if (!session || session.revokedAt) return { ok: false, error: expired, clearCookie: true };
    if (session.expiresAt.getTime() <= now.getTime()) return { ok: false, error: expired, clearCookie: true };

    const idleMs = this.config.security.sessionIdleTimeoutMinutes * 60_000;
    if (now.getTime() - session.lastSeenAt.getTime() > idleMs) {
      await this.prisma.session
        .updateMany({
          where: { id: session.id, revokedAt: null },
          data: { revokedAt: now, revokeReason: 'idle_timeout' },
        })
        .catch((err: unknown) => this.logger.warn({ err }, 'Failed to revoke idle session'));
      return { ok: false, error: expired, clearCookie: true };
    }

    const user = session.user;
    if (user.status === 'SUSPENDED') {
      return {
        ok: false,
        error: new AppError(ErrorCode.AccountSuspended, 'Your account is suspended', 403),
        clearCookie: true,
      };
    }
    if (user.status !== 'ACTIVE') return { ok: false, error: unauthenticated(), clearCookie: true };

    const roles = user.roles
      .map((r) => r.role.key)
      .filter((k): k is RoleKey => (RoleKeys as readonly string[]).includes(k));
    const permissions = new Set<Permission>();
    for (const r of user.roles) for (const p of r.role.permissions) permissions.add(p.permission.key as Permission);

    if (now.getTime() - session.lastSeenAt.getTime() >= LAST_SEEN_UPDATE_INTERVAL_MS) {
      await this.prisma.session
        .updateMany({
          where: { id: session.id, lastSeenAt: { lt: new Date(now.getTime() - LAST_SEEN_UPDATE_INTERVAL_MS + 1) } },
          data: { lastSeenAt: now },
        })
        .catch((err: unknown) => this.logger.warn({ err }, 'Failed to refresh session lastSeenAt'));
    }

    const auth: AuthContext = {
      userId: user.id,
      sessionId: session.id,
      email: user.email,
      fullName: user.fullName,
      roles,
      permissions,
      programScopes: user.programAssignments.map((a) => a.programId),
      isAdmin: roles.some(isAdminRole),
      mfaVerified: session.mfaVerified,
      sessionExpiresAt: session.expiresAt,
    };
    return { ok: true, auth };
  }
}
