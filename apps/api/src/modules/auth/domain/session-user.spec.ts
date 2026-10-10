import { describe, expect, it } from 'vitest';
import type { Permission } from '@app/shared';
import type { AuthContext } from '../../../common/auth/auth-context';
import { adminMfaStep, maskIp, toSessionUserDto } from './session-user';

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'u1',
    sessionId: 's1',
    email: 'anita@example.com',
    fullName: 'Anita Sharma',
    roles: ['MEMBER'],
    permissions: new Set<Permission>(),
    programScopes: [],
    isAdmin: false,
    mfaMethod: null,
    mfaVerifiedAt: null,
    hasTotpFactor: false,
    adminAccess: false,
    sessionExpiresAt: new Date(),
    ...overrides,
  };
}

describe('session user mapping', () => {
  it('maps the auth context and sorts permissions into an array', () => {
    const dto = toSessionUserDto(
      auth({
        roles: ['MEMBER', 'FINANCE_REVIEWER'],
        permissions: new Set<Permission>(['rewards:read', 'audit:read']),
        isAdmin: true,
        mfaMethod: 'TOTP',
        hasTotpFactor: true,
        adminAccess: true,
      }),
      { emailVerifiedAt: new Date(), avatarUrl: null },
    );
    expect(dto).toEqual({
      id: 'u1',
      fullName: 'Anita Sharma',
      email: 'anita@example.com',
      emailVerified: true,
      avatarUrl: null,
      roles: ['MEMBER', 'FINANCE_REVIEWER'],
      permissions: ['audit:read', 'rewards:read'],
      isAdmin: true,
      adminAccess: true,
      mfaMethod: 'TOTP',
      hasTotpFactor: true,
    });
    expect(Object.keys(dto)).not.toContain('sessionId');
  });

  it('derives the admin MFA step', () => {
    expect(adminMfaStep(auth())).toBeNull();
    expect(adminMfaStep(auth({ isAdmin: true }))).toBe('TOTP_ENROLLMENT');
    expect(adminMfaStep(auth({ isAdmin: true, hasTotpFactor: true }))).toBe('TOTP');
    expect(adminMfaStep(auth({ isAdmin: true, hasTotpFactor: true, adminAccess: true }))).toBeNull();
  });

  it('masks IPs', () => {
    expect(maskIp('203.0.113.7')).toBe('203.0.113.x');
    expect(maskIp('::ffff:198.51.100.23')).toBe('198.51.100.x');
    expect(maskIp('2001:db8:85a3:8d3:1319:8a2e:370:7348')).toBe('2001:db8:85a3::x');
    expect(maskIp(null)).toBeNull();
    expect(maskIp('not-an-ip')).toBeNull();
  });
});
