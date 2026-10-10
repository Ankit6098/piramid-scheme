import { describe, expect, it } from 'vitest';
import { diffProfile, toActivityDto, toProfileDto, toUserSessionDto } from './profile';

describe('profile mapping', () => {
  const base = {
    id: 'u1',
    fullName: 'Anita Sharma',
    email: 'anita@example.com',
    emailVerifiedAt: new Date('2026-01-01T00:00:00Z'),
    phone: null,
    avatarUrl: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastLoginAt: null,
    passwordChangedAt: null,
    roles: [{ role: { key: 'MEMBER' } }, { role: { key: 'FINANCE_REVIEWER' } }, { role: { key: 'LEGACY' } }],
    mfaFactors: [{ confirmedAt: new Date('2026-02-01T00:00:00Z') }],
  };

  it('maps roles, admin flag and the authenticator status', () => {
    const dto = toProfileDto(base);
    expect(dto.roles).toEqual(['MEMBER', 'FINANCE_REVIEWER']);
    expect(dto.isAdmin).toBe(true);
    expect(dto.hasTotpFactor).toBe(true);
    expect(dto.totpEnrolledAt).toBe('2026-02-01T00:00:00.000Z');
    expect(dto).not.toHaveProperty('passwordHash');
    expect(toProfileDto({ ...base, roles: [{ role: { key: 'MEMBER' } }], mfaFactors: [] })).toMatchObject({
      isAdmin: false,
      hasTotpFactor: false,
      totpEnrolledAt: null,
    });
  });

  it('flags the current session', () => {
    const row = {
      id: 's1',
      createdAt: new Date(),
      lastSeenAt: new Date(),
      expiresAt: new Date(),
      ipAddress: '203.0.113.9',
      userAgent: 'UA',
      mfaMethod: null,
    };
    expect(toUserSessionDto(row, 's1').current).toBe(true);
    expect(toUserSessionDto(row, 's2').current).toBe(false);
  });

  it('masks the IP in activity entries', () => {
    expect(
      toActivityDto({ id: 'a', action: 'auth.login', resourceType: 'session', createdAt: new Date(0), ipAddress: '203.0.113.9' }),
    ).toEqual({ id: 'a', action: 'auth.login', resourceType: 'session', createdAt: '1970-01-01T00:00:00.000Z', ipAddress: '203.0.113.x' });
  });

  it('diffs only changed profile fields', () => {
    const current = { fullName: 'Anita', phone: '+911234567', avatarUrl: null };
    expect(diffProfile(current, { fullName: 'Anita', phone: null })).toEqual({
      changed: { phone: null },
      before: { phone: '+911234567' },
    });
    expect(diffProfile(current, {})).toEqual({ changed: {}, before: {} });
  });
});
