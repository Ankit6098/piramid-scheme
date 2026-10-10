import { createPrismaClient } from '../../src/common/prisma/create-client';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { seedReferenceData } from '../../prisma/seed-lib';
import { assertSafeTestDatabaseUrl } from './test-db-url';

/**
 * Test database helpers. Everything honours `process.env.TEST_DATABASE_URL` at call time, so a test
 * file (or the command line) can target a dedicated database, e.g.
 *   TEST_DATABASE_URL=postgresql://referral:referral_dev_password@localhost:5432/referral_test_auth?schema=public
 * (globalSetup creates + migrates it automatically.)
 */
export function testDatabaseUrl(): string {
  return assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
}

const clients = new Map<string, PrismaClient>();

/** Shared PrismaClient (driver adapter) for TEST_DATABASE_URL. Disconnected by `disconnectTestPrisma()`. */
export function testPrisma(): PrismaClient {
  const url = testDatabaseUrl();
  let client = clients.get(url);
  if (!client) {
    client = createPrismaClient(url, 4);
    clients.set(url, client);
  }
  return client;
}

export async function disconnectTestPrisma(): Promise<void> {
  await Promise.all([...clients.values()].map((c) => c.$disconnect()));
  clients.clear();
}

/** Tables kept by `resetDatabase`: migration history and migration-seeded reference data. */
export const PRESERVED_TABLES = ['_prisma_migrations', 'currencies'] as const;

/**
 * TRUNCATEs every application table (RESTART IDENTITY CASCADE; `_prisma_migrations` and the
 * `currencies` reference data are kept), then re-seeds roles, permissions, role_permissions and
 * platform_settings. TRUNCATE does not fire the row-level append-only/guard triggers, so
 * ledger/audit/referral tables are wiped too.
 */
export async function resetDatabase(prisma: PrismaClient = testPrisma()): Promise<void> {
  const preserved = new Set<string>(PRESERVED_TABLES);
  const tables = (
    await prisma.$queryRaw<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
  ).filter((t) => !preserved.has(t.tablename));
  if (tables.length) {
    const list = tables.map((t) => `"public"."${t.tablename.replace(/"/g, '""')}"`).join(', ');
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  }
  await seedReferenceData(prisma);
}
