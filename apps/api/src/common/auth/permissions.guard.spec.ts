import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLE_PERMISSIONS, type Permission, type RoleKey } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors/app-error';
import { ADMIN_MFA_MAX_AGE_MS, computeAdminAccess, type AuthContext } from './auth-context';
import { REQUIRED_PERMISSIONS_KEY } from './decorators';
import { PermissionsGuard, assertPermissions } from './permissions.guard';
import { assertProgramAccess, canAccessProgram, programScopeFilter } from './program-access';
import { assertAdminAccess, isAdminPath } from './session-auth.guard';

function auth(roles: RoleKey[], programScopes: string[] = [], overrides: Partial<AuthContext> = {}): AuthContext {
  const permissions = new Set<Permission>(roles.flatMap((r) => ROLE_PERMISSIONS[r]));
  const isAdmin = roles.some((r) => r !== 'MEMBER');
  return {
    userId: 'u1',
    sessionId: 's1',
    email: 'u1@example.com',
    fullName: 'U One',
    roles: ['MEMBER', ...roles.filter((r) => r !== 'MEMBER')],
    permissions,
    programScopes,
    isAdmin,
    mfaMethod: 'TOTP',
    mfaVerifiedAt: new Date(),
    hasTotpFactor: isAdmin,
    adminAccess: isAdmin,
    sessionExpiresAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  };
}

function errorOf(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return e as AppError;
  }
  throw new Error('expected an AppError');
}

describe('assertPermissions / PermissionsGuard', () => {
  it('passes when no permissions are required', () => {
    expect(() => assertPermissions(null, [])).not.toThrow();
  });

  it('401 without auth, 403 with missing permissions (all are required)', () => {
    expect(errorOf(() => assertPermissions(null, ['rewards:approve'])).code).toBe('UNAUTHENTICATED');
    const e = errorOf(() => assertPermissions(auth(['PROGRAM_ADMIN']), ['rewards:read', 'rewards:approve']));
    expect(e.code).toBe('FORBIDDEN');
    expect(e.httpStatus).toBe(403);
    expect(e.details).toEqual({ missingPermissions: ['rewards:approve'] });
    expect(() => assertPermissions(auth(['FINANCE_REVIEWER']), ['rewards:read', 'rewards:approve'])).not.toThrow();
    expect(() => assertPermissions(auth(['SUPER_ADMIN']), ['settings:write', 'referrals:correct'])).not.toThrow();
  });

  function ctx(a: AuthContext | null, handlerPerms?: Permission[], classPerms?: Permission[]): ExecutionContext {
    const handler = () => undefined;
    class Ctrl {}
    if (handlerPerms) Reflect.defineMetadata(REQUIRED_PERMISSIONS_KEY, handlerPerms, handler);
    if (classPerms) Reflect.defineMetadata(REQUIRED_PERMISSIONS_KEY, classPerms, Ctrl);
    return {
      getType: () => 'http',
      getHandler: () => handler,
      getClass: () => Ctrl,
      switchToHttp: () => ({ getRequest: () => ({ auth: a }) }),
    } as unknown as ExecutionContext;
  }

  const guard = new PermissionsGuard(new Reflector());

  it('allows routes without @RequirePermissions', () => {
    expect(guard.canActivate(ctx(null))).toBe(true);
  });

  it('enforces handler metadata, falling back to class metadata', () => {
    expect(guard.canActivate(ctx(auth(['FINANCE_REVIEWER']), ['ledger:read']))).toBe(true);
    expect(errorOf(() => guard.canActivate(ctx(auth([]), ['ledger:read']))).code).toBe('FORBIDDEN');
    expect(errorOf(() => guard.canActivate(ctx(auth(['PROGRAM_ADMIN']), undefined, ['ledger:read']))).code).toBe('FORBIDDEN');
    // method-level overrides class-level
    expect(guard.canActivate(ctx(auth(['PROGRAM_ADMIN']), ['programs:write'], ['ledger:read']))).toBe(true);
  });
});

describe('assertProgramAccess', () => {
  const P1 = 'program-1';
  const P2 = 'program-2';

  it('SUPER_ADMIN can read and write every program', () => {
    expect(canAccessProgram(auth(['SUPER_ADMIN']), P1, 'write')).toBe(true);
    expect(programScopeFilter(auth(['SUPER_ADMIN']), 'write')).toBe('ALL');
  });

  it('PROGRAM_ADMIN only reaches assigned programs', () => {
    const a = auth(['PROGRAM_ADMIN'], [P1]);
    expect(() => assertProgramAccess(a, P1, 'write')).not.toThrow();
    expect(() => assertProgramAccess(a, P1, 'read')).not.toThrow();
    expect(errorOf(() => assertProgramAccess(a, P2, 'write')).code).toBe('FORBIDDEN');
    expect(errorOf(() => assertProgramAccess(a, P2, 'read')).code).toBe('FORBIDDEN');
    expect(programScopeFilter(a, 'read')).toEqual([P1]);
  });

  it('FINANCE_REVIEWER has read-only access to all programs', () => {
    const a = auth(['FINANCE_REVIEWER']);
    expect(() => assertProgramAccess(a, P2, 'read')).not.toThrow();
    expect(errorOf(() => assertProgramAccess(a, P2, 'write')).code).toBe('FORBIDDEN');
    expect(errorOf(() => assertProgramAccess(a, P2)).code).toBe('FORBIDDEN'); // default mode = write
    expect(programScopeFilter(a, 'read')).toBe('ALL');
    expect(programScopeFilter(a, 'write')).toEqual([]);
  });

  it('combined PROGRAM_ADMIN + FINANCE_REVIEWER: read all, write assigned only', () => {
    const a = auth(['PROGRAM_ADMIN', 'FINANCE_REVIEWER'], [P1]);
    expect(canAccessProgram(a, P2, 'read')).toBe(true);
    expect(canAccessProgram(a, P2, 'write')).toBe(false);
    expect(canAccessProgram(a, P1, 'write')).toBe(true);
  });

  it('MEMBER has no admin program access', () => {
    expect(canAccessProgram(auth([]), P1, 'read')).toBe(false);
    expect(programScopeFilter(auth([]), 'read')).toEqual([]);
  });
});

describe('isAdminPath', () => {
  it('matches /api/v<n>/admin and below, case-insensitively', () => {
    expect(isAdminPath('/api/v1/admin')).toBe(true);
    expect(isAdminPath('/api/v1/admin/programs/:id')).toBe(true);
    expect(isAdminPath('/api/v1/ADMIN/x')).toBe(true);
    expect(isAdminPath('/api/v1/administrators')).toBe(false);
    expect(isAdminPath('/api/v1/programs/admin')).toBe(false);
  });
});

describe('admin access (TOTP within 12 h)', () => {
  const now = new Date('2026-10-10T12:00:00.000Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it('computeAdminAccess requires an admin role, mfaMethod TOTP and a fresh verification', () => {
    expect(computeAdminAccess({ isAdmin: true, mfaMethod: 'TOTP', mfaVerifiedAt: ago(1000) }, now)).toBe(true);
    expect(computeAdminAccess({ isAdmin: true, mfaMethod: 'TOTP', mfaVerifiedAt: ago(ADMIN_MFA_MAX_AGE_MS - 1000) }, now)).toBe(true);
    expect(computeAdminAccess({ isAdmin: true, mfaMethod: 'TOTP', mfaVerifiedAt: ago(ADMIN_MFA_MAX_AGE_MS) }, now)).toBe(false);
    expect(computeAdminAccess({ isAdmin: true, mfaMethod: 'EMAIL_OTP', mfaVerifiedAt: ago(1000) }, now)).toBe(false);
    expect(computeAdminAccess({ isAdmin: true, mfaMethod: null, mfaVerifiedAt: null }, now)).toBe(false);
    expect(computeAdminAccess({ isAdmin: false, mfaMethod: 'TOTP', mfaVerifiedAt: ago(1000) }, now)).toBe(false);
    // verification timestamps from the future (clock skew > 1 min) are not trusted
    expect(computeAdminAccess({ isAdmin: true, mfaMethod: 'TOTP', mfaVerifiedAt: new Date(now.getTime() + 120_000) }, now)).toBe(false);
  });

  it('assertAdminAccess: FORBIDDEN for members, MFA_REQUIRED with a reason for admins', () => {
    expect(errorOf(() => assertAdminAccess(auth([]))).code).toBe('FORBIDDEN');
    expect(() => assertAdminAccess(auth(['FINANCE_REVIEWER']))).not.toThrow();

    const noFactor = errorOf(() => assertAdminAccess(auth(['SUPER_ADMIN'], [], { adminAccess: false, hasTotpFactor: false })));
    expect(noFactor.code).toBe('MFA_REQUIRED');
    expect(noFactor.httpStatus).toBe(403);
    expect(noFactor.details).toEqual({ reason: 'TOTP_ENROLLMENT_REQUIRED' });

    const needsCode = errorOf(() => assertAdminAccess(auth(['PROGRAM_ADMIN'], [], { adminAccess: false, hasTotpFactor: true })));
    expect(needsCode.details).toEqual({ reason: 'TOTP_REQUIRED' });
  });
});
