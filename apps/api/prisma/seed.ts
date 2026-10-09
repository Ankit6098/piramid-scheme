/**
 * Idempotent seed: `corepack pnpm --filter @app/api db:seed` (tsx prisma/seed.ts).
 * 1. roles / permissions / role_permissions from @app/shared ROLE_PERMISSIONS + platform_settings
 * 2. a SUPER_ADMIN from SEED_SUPER_ADMIN_EMAIL / SEED_SUPER_ADMIN_PASSWORD
 * 3. demo data when SEED_DEMO_DATA=true (seedDemoData — filled in by a later phase)
 * Platform ledger accounts are created lazily by the ledger module, not here.
 */
import { loadEnvFiles } from '../src/config/app-config';
import { createPrismaClient } from '../src/common/prisma/create-client';
import type { PrismaClient } from '../src/generated/prisma/client';
import { seedReferenceData, seedSuperAdmin } from './seed-lib';

// ════════════════════════════════════════════════════════════════════════════
// TODO(demo-data phase): seedDemoData()
// Fill with offerings, programs (+ options, published policy versions), a member tree with
// enrollments and a few qualifying events processed through the reward engine. Must stay idempotent
// (look up by unique keys before inserting) and must never pay rewards for recruitment alone.
// ════════════════════════════════════════════════════════════════════════════
export async function seedDemoData(prisma: PrismaClient): Promise<void> {
  void prisma;
  console.log('[seed] seedDemoData(): not implemented yet — skipped');
}

async function main(): Promise<void> {
  loadEnvFiles();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const prisma = createPrismaClient(url, 2);
  try {
    await seedReferenceData(prisma);
    console.log('[seed] roles, permissions and platform settings are in sync');

    const email = process.env.SEED_SUPER_ADMIN_EMAIL;
    const password = process.env.SEED_SUPER_ADMIN_PASSWORD;
    if (email && password) {
      const admin = await seedSuperAdmin(prisma, { email, password });
      console.log(
        `[seed] super admin ${admin.created ? 'created' : 'already present'} (referral code ${admin.referralCode})`,
      );
    } else {
      console.log('[seed] SEED_SUPER_ADMIN_EMAIL / SEED_SUPER_ADMIN_PASSWORD not set — no super admin created');
    }

    if (/^(true|1|yes)$/i.test(process.env.SEED_DEMO_DATA ?? '')) await seedDemoData(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('[seed] failed:', err);
    process.exit(1);
  });
}
