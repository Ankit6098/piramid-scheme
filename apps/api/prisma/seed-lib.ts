import { randomInt } from 'node:crypto';
import * as argon2 from 'argon2';
import {
  ALL_PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  RoleKey,
  SUPPORTED_CURRENCIES,
} from '@app/shared';
import { lockReferralTreeShared } from '../src/common/prisma/referral-tree-lock';
import type { PrismaClient } from '../src/generated/prisma/client';

/** Referral code alphabet (business rules §6): upper-case, no 0/O/1/I/L. */
export const REFERRAL_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const REFERRAL_CODE_LENGTH = 8;

export function generateReferralCode(): string {
  let s = '';
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) s += REFERRAL_CODE_ALPHABET[randomInt(REFERRAL_CODE_ALPHABET.length)];
  return s;
}

const ROLE_DESCRIPTIONS: Record<RoleKey, string> = {
  SUPER_ADMIN: 'Everything: settings, roles, offering approval, auto-approving policies, API clients, referral corrections, audit, flags',
  PROGRAM_ADMIN: 'Assigned programs only: options, policies (approval-requiring), lifecycle, enrollments, sales',
  FINANCE_REVIEWER: 'Approves/rejects/reverses rewards, reverses events; ledger, reconciliation, exports, audit (read)',
  MEMBER: 'Own profile, enrollments, referral code, team and rewards',
};

/** argon2id with library defaults (m=64 MiB, t=3, p=4). */
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

/** Business rule §2: ≥ 10 chars, at least one letter and one digit. */
export function isAcceptablePassword(password: string): boolean {
  return password.length >= 10 && /[A-Za-z]/.test(password) && /\d/.test(password);
}

/**
 * Idempotently syncs roles, permissions and role_permissions with `@app/shared` ROLE_PERMISSIONS
 * (stale role→permission links and permissions that no longer exist are removed) and ensures the
 * platform_settings singleton exists (INSERT … ON CONFLICT DO NOTHING — an existing row, and its
 * version, are never touched). Currencies are reference data seeded by the integrity migration.
 */
export async function seedReferenceData(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Normally seeded by the integrity migration; re-insert any missing row (never updates: immutable).
    await tx.currency.createMany({
      data: SUPPORTED_CURRENCIES.map((c) => ({ code: c.code, name: c.name, minorUnits: c.minorUnits })),
      skipDuplicates: true,
    });
    for (const key of ALL_PERMISSIONS) {
      await tx.permission.upsert({
        where: { key },
        create: { key, description: PERMISSION_DESCRIPTIONS[key] },
        update: { description: PERMISSION_DESCRIPTIONS[key] },
      });
    }
    for (const key of RoleKey) {
      await tx.role.upsert({
        where: { key },
        create: { key, name: ROLE_LABELS[key], description: ROLE_DESCRIPTIONS[key] },
        update: { name: ROLE_LABELS[key], description: ROLE_DESCRIPTIONS[key] },
      });
    }
    await tx.permission.deleteMany({ where: { key: { notIn: [...ALL_PERMISSIONS] } } });
    const roles = await tx.role.findMany({ where: { key: { in: [...RoleKey] } }, select: { id: true, key: true } });
    const perms = await tx.permission.findMany({ select: { id: true, key: true } });
    const permId = new Map(perms.map((p) => [p.key, p.id]));
    for (const role of roles) {
      const wanted = (ROLE_PERMISSIONS[role.key as RoleKey] ?? []).map((k) => permId.get(k)).filter((id): id is string => !!id);
      await tx.rolePermission.deleteMany({ where: { roleId: role.id, permissionId: { notIn: wanted } } });
      if (wanted.length) {
        await tx.rolePermission.createMany({
          data: wanted.map((permissionId) => ({ roleId: role.id, permissionId })),
          skipDuplicates: true,
        });
      }
    }
    await tx.platformSettings.createMany({ data: [{ id: 1 }], skipDuplicates: true });
  });
}

export interface SeedSuperAdminInput {
  email: string;
  password: string;
  fullName?: string;
  /** Preferred referral code (falls back to a random one if taken). */
  referralCode?: string;
}

/**
 * Idempotently ensures a SUPER_ADMIN exists, following the referral write protocol (business rules
 * §6) in ONE interactive transaction without savepoints:
 *   INSERT users (ACTIVE + verified, argon2id password) → pg_advisory_xact_lock_shared(7301, 1)
 *   → depth-0 closure row → global referral code → roles MEMBER + SUPER_ADMIN.
 * Re-runs find the user by email and only add what is missing (roles, referral code); an existing
 * password is never overwritten. (Closure rows can only be written by the creating transaction, so a
 * pre-existing user without one is reported, not repaired.)
 */
export async function seedSuperAdmin(
  prisma: PrismaClient,
  input: SeedSuperAdminInput,
): Promise<{ userId: string; created: boolean; referralCode: string }> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error('SEED_SUPER_ADMIN_EMAIL is not a valid email address');
  if (!isAcceptablePassword(input.password)) {
    throw new Error('SEED_SUPER_ADMIN_PASSWORD must be ≥ 10 characters with at least one letter and one digit');
  }
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  const passwordHash = existing ? null : await hashPassword(input.password);

  return prisma.$transaction(async (tx) => {
    let userId = existing?.id ?? null;
    let created = false;
    if (!userId) {
      const now = new Date();
      const user = await tx.user.create({
        data: {
          email,
          fullName: input.fullName ?? 'Super Admin',
          status: 'ACTIVE',
          emailVerifiedAt: now,
          passwordHash,
          passwordChangedAt: now,
        },
        select: { id: true },
      });
      userId = user.id;
      created = true;
      await lockReferralTreeShared(tx);
      await tx.referralPath.create({ data: { ancestorId: userId, descendantId: userId, depth: 0 } });
    } else {
      const self = await tx.referralPath.findUnique({
        where: { ancestorId_descendantId: { ancestorId: userId, descendantId: userId } },
        select: { depth: true },
      });
      if (!self) console.warn(`[seed] user ${userId} has no depth-0 closure row (created outside the registration protocol)`);
    }

    const existingCode = await tx.referralCode.findFirst({
      where: { userId, programId: null, isActive: true },
      select: { code: true },
    });
    let referralCode = existingCode?.code;
    if (!referralCode) {
      const preferred = input.referralCode ?? 'SUPRADMN';
      const candidates = [preferred, ...Array.from({ length: 10 }, generateReferralCode)];
      for (const code of candidates) {
        const taken = await tx.referralCode.findUnique({ where: { code }, select: { id: true } });
        if (taken) continue;
        await tx.referralCode.create({ data: { userId, code } });
        referralCode = code;
        break;
      }
    }
    if (!referralCode) throw new Error('Could not allocate a referral code');

    const roles = await tx.role.findMany({ where: { key: { in: ['MEMBER', 'SUPER_ADMIN'] } }, select: { id: true } });
    if (roles.length !== 2) throw new Error('Roles are missing — run seedReferenceData first');
    const uid = userId;
    await tx.userRole.createMany({ data: roles.map((r) => ({ userId: uid, roleId: r.id })), skipDuplicates: true });
    return { userId: uid, created, referralCode };
  });
}
