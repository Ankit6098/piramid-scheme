import type { MfaMethod, Permission, RoleKey } from '@app/shared';

/** `/admin/*` needs a TOTP verification no older than this (business rules §2). */
export const ADMIN_MFA_MAX_AGE_MS = 12 * 3_600_000;

/**
 * The authenticated principal for one request. Built by `SessionAuthGuard` from the `sid` cookie and
 * available via `@CurrentUser()` or `RequestContext.auth`. Roles and permissions are loaded from the
 * database on every request (no caching), so a role revocation takes effect immediately.
 *
 * `permissions` is a Set: when returning it to clients map it explicitly (`[...auth.permissions]`).
 */
export interface AuthContext {
  readonly userId: string;
  readonly sessionId: string;
  readonly email: string;
  readonly fullName: string;
  readonly roles: readonly RoleKey[];
  readonly permissions: ReadonlySet<Permission>;
  /** Program ids assigned to this user via program_admin_assignments (meaningful for PROGRAM_ADMIN). */
  readonly programScopes: readonly string[];
  /** Holds at least one non-MEMBER role (SUPER_ADMIN, PROGRAM_ADMIN, FINANCE_REVIEWER). */
  readonly isAdmin: boolean;
  /** Second factor completed in THIS session (null = none). Email OTP never grants admin access. */
  readonly mfaMethod: MfaMethod | null;
  readonly mfaVerifiedAt: Date | null;
  /** The user has a confirmed, non-revoked TOTP factor (else admins must enroll one first). */
  readonly hasTotpFactor: boolean;
  /**
   * May use /api/v1/admin/*: `isAdmin` AND `mfaMethod === 'TOTP'` AND `mfaVerifiedAt` within the last
   * 12 h (`ADMIN_MFA_MAX_AGE_MS`). Computed when the session is resolved.
   */
  readonly adminAccess: boolean;
  readonly sessionExpiresAt: Date;
}

/** Pure rule behind `AuthContext.adminAccess` (unit-tested). */
export function computeAdminAccess(
  input: { isAdmin: boolean; mfaMethod: MfaMethod | null; mfaVerifiedAt: Date | null },
  now: Date = new Date(),
): boolean {
  if (!input.isAdmin || input.mfaMethod !== 'TOTP' || !input.mfaVerifiedAt) return false;
  const age = now.getTime() - input.mfaVerifiedAt.getTime();
  return age >= -60_000 && age < ADMIN_MFA_MAX_AGE_MS;
}

export function hasRole(auth: AuthContext, role: RoleKey): boolean {
  return auth.roles.includes(role);
}

export function hasPermission(auth: AuthContext, permission: Permission): boolean {
  return auth.permissions.has(permission);
}

export function hasAllPermissions(auth: AuthContext, permissions: readonly Permission[]): boolean {
  return permissions.every((p) => auth.permissions.has(p));
}
