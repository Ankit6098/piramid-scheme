import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { API_ROOT, loadEnvFiles } from '../../src/config/app-config';
import { assertSafeTestDatabaseUrl } from '../utils/test-db-url';

/**
 * Vitest globalSetup for integration tests (runs once, before any test file):
 * 1. resolves TEST_DATABASE_URL (command-line env wins over .env files);
 * 2. creates that database if it does not exist (so each slice can use its own, e.g. referral_test_auth);
 * 3. applies all migrations with `prisma migrate deploy`.
 */
export default async function globalSetup(): Promise<void> {
  loadEnvFiles();
  const url = assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
  await ensureDatabaseExists(url);

  const prismaCli = resolve(API_ROOT, 'node_modules', 'prisma', 'build', 'index.js');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: url },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
}

async function ensureDatabaseExists(url: string): Promise<void> {
  const target = new URL(url);
  const dbName = decodeURIComponent(target.pathname.replace(/^\//, ''));
  const admin = new URL(url);
  admin.pathname = '/postgres';
  admin.search = '';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rowCount === 0) {
      await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    }
  } finally {
    await client.end();
  }
}
