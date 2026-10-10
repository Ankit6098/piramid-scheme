import type { AdminMfaStep, Permission, SessionUserDto } from '@app/shared';
import type { AuthContext } from '../../../common/auth/auth-context';

/** Maps a resolved session (+ the profile bits the AuthContext does not carry) to the public DTO. */
export function toSessionUserDto(
  auth: AuthContext,
  profile: { emailVerifiedAt: Date | null; avatarUrl: string | null },
): SessionUserDto {
  return {
    id: auth.userId,
    fullName: auth.fullName,
    email: auth.email,
    emailVerified: profile.emailVerifiedAt !== null,
    avatarUrl: profile.avatarUrl,
    roles: [...auth.roles],
    permissions: [...auth.permissions].sort() as Permission[],
    isAdmin: auth.isAdmin,
    adminAccess: auth.adminAccess,
    mfaMethod: auth.mfaMethod,
    hasTotpFactor: auth.hasTotpFactor,
  };
}

/** Which second step an admin session still needs (null = none: member, or admin access granted). */
export function adminMfaStep(auth: Pick<AuthContext, 'isAdmin' | 'adminAccess' | 'hasTotpFactor'>): AdminMfaStep | null {
  if (!auth.isAdmin || auth.adminAccess) return null;
  return auth.hasTotpFactor ? 'TOTP' : 'TOTP_ENROLLMENT';
}

/**
 * Masks the host part of an IP for activity views: IPv4 `203.0.113.7` → `203.0.113.x`; IPv6 keeps the
 * first three groups (`2001:db8:85a3::x`).
 */
export function maskIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v = ip.trim();
  const v4 = v.startsWith('::ffff:') && v.includes('.') ? v.slice(7) : v;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) return `${v4.split('.').slice(0, 3).join('.')}.x`;
  if (v.includes(':')) {
    const groups = v.split(':').filter((g) => g.length > 0);
    return `${groups.slice(0, 3).join(':')}::x`;
  }
  return null;
}
