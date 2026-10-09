import type { Permission, RoleKey } from '@app/shared';

/**
 * The authenticated principal for one request. Built by `SessionAuthGuard` from the `sid` cookie and
 * available via `@CurrentUser()` or `RequestContext.auth`.
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
  /** Session completed the email-OTP second factor. Required for /api/v1/admin/*. */
  readonly mfaVerified: boolean;
  readonly sessionExpiresAt: Date;
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
