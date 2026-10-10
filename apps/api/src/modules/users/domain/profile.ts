import { isAdminRole, RoleKey, type ActivityEntryDto, type ProfileDto, type UserSessionDto } from '@app/shared';
import { maskIp } from '../../auth/domain/session-user';

export interface ProfileRow {
  id: string;
  fullName: string;
  email: string;
  emailVerifiedAt: Date | null;
  phone: string | null;
  avatarUrl: string | null;
  createdAt: Date;
  lastLoginAt: Date | null;
  passwordChangedAt: Date | null;
  roles: Array<{ role: { key: string } }>;
  mfaFactors: Array<{ confirmedAt: Date | null }>;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toProfileDto(row: ProfileRow): ProfileDto {
  const roles = row.roles.map((r) => r.role.key).filter((k): k is RoleKey => (RoleKey as readonly string[]).includes(k));
  const factor = row.mfaFactors.find((f) => f.confirmedAt !== null) ?? null;
  return {
    id: row.id,
    fullName: row.fullName,
    email: row.email,
    emailVerifiedAt: iso(row.emailVerifiedAt),
    phone: row.phone,
    avatarUrl: row.avatarUrl,
    createdAt: row.createdAt.toISOString(),
    lastLoginAt: iso(row.lastLoginAt),
    passwordChangedAt: iso(row.passwordChangedAt),
    roles,
    isAdmin: roles.some(isAdminRole),
    hasTotpFactor: factor !== null,
    totpEnrolledAt: iso(factor?.confirmedAt ?? null),
  };
}

export interface SessionRow {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  mfaMethod: 'EMAIL_OTP' | 'TOTP' | null;
}

export function toUserSessionDto(row: SessionRow, currentSessionId: string): UserSessionDto {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    mfaMethod: row.mfaMethod,
    current: row.id === currentSessionId,
  };
}

export interface ActivityRow {
  id: string;
  action: string;
  resourceType: string;
  createdAt: Date;
  ipAddress: string | null;
}

/** Own activity: action + time + masked IP only (no before/after, no other people's ids). */
export function toActivityDto(row: ActivityRow): ActivityEntryDto {
  return {
    id: row.id,
    action: row.action,
    resourceType: row.resourceType,
    createdAt: row.createdAt.toISOString(),
    ipAddress: maskIp(row.ipAddress),
  };
}

/** Only the fields that really change, as `{ before, after }` allow-lists for the audit entry. */
export function diffProfile(
  current: { fullName: string; phone: string | null; avatarUrl: string | null },
  patch: { fullName?: string; phone?: string | null; avatarUrl?: string | null },
): { changed: Partial<typeof current>; before: Partial<typeof current> } {
  const changed: Partial<typeof current> = {};
  const before: Partial<typeof current> = {};
  for (const key of ['fullName', 'phone', 'avatarUrl'] as const) {
    const next = patch[key];
    if (next === undefined || next === current[key]) continue;
    (changed as Record<string, unknown>)[key] = next;
    (before as Record<string, unknown>)[key] = current[key];
  }
  return { changed, before };
}
