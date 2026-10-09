import { randomInt } from 'node:crypto';
import * as argon2 from 'argon2';
import { ALL_PERMISSIONS, PERMISSION_DESCRIPTIONS, ROLE_LABELS, ROLE_PERMISSIONS, RoleKey } from '@app/shared';
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
  SUPER_ADMIN: 'Everything, including platform settings, role assignment and referral corrections',
  PROGRAM_ADMIN: 'Manages assigned programs: options, policies, lifecycle, qualifying events',
  FINANCE_REVIEWER: 'Approves/rejects/reverses rewards; ledger, reconciliation and exports',
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
 * (stale role→permission links are removed) and ensures the platform_settings singleton exists.
 */
export async function seedReferenceData(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(async (tx) => {
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
    await tx.platformSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
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
 * Idempotently ensures a SUPER_ADMIN exists: ACTIVE, verified, argon2id password (only set on
 * creation — an existing password is never overwritten), roles MEMBER + SUPER_ADMIN, depth-0 closure
 * row and a global referral code.
 */
export async function seedSuperAdmin(
  prisma: PrismaClient,
  input: SeedSuperAdminInput,
): Promise<{ userId: string; created: boolean; referralCode: string }> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes('@')) throw new Error('SEED_SUPER_ADMIN_EMAIL is not a valid email address');
  if (!isAcceptablePassword(input.password)) {
    throw new Error('SEED_SUPER_ADMIN_PASSWORD must be ≥ 10 characters with at least one letter and one digit');
  }
  const passwordHash = await hashPassword(input.password);

  return prisma.$transaction(async (tx) => {
    let user = await tx.user.findUnique({ where: { email }, select: { id: true } });
    let created = false;
    if (!user) {
      const now = new Date();
      user = await tx.user.create({
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
      created = true;
    }
    const roles = await tx.role.findMany({ where: { key: { in: ['MEMBER', 'SUPER_ADMIN'] } }, select: { id: true } });
    if (roles.length !== 2) throw new Error('Roles are missing — run seedReferenceData first');
    await tx.userRole.createMany({ data: roles.map((r) => ({ userId: user.id, roleId: r.id })), skipDuplicates: true });
    await tx.referralPath.createMany({
      data: [{ ancestorId: user.id, descendantId: user.id, depth: 0 }],
      skipDuplicates: true,
    });

    const existingCode = await tx.referralCode.findFirst({
      where: { userId: user.id, programId: null, isActive: true },
      select: { code: true },
    });
    let referralCode = existingCode?.code;
    if (!referralCode) {
      const preferred = input.referralCode ?? 'SUPRADMN';
      const candidates = [preferred, ...Array.from({ length: 10 }, generateReferralCode)];
      for (const code of candidates) {
        const taken = await tx.referralCode.findUnique({ where: { code }, select: { id: true } });
        if (taken) continue;
        await tx.referralCode.create({ data: { userId: user.id, code } });
        referralCode = code;
        break;
      }
    }
    if (!referralCode) throw new Error('Could not allocate a referral code');
    return { userId: user.id, created, referralCode };
  });
}
