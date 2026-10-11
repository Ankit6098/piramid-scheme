/**
 * Direct SQL against the e2e stack's PostgreSQL container (docker exec … psql), for the few cases a
 * browser cannot reach — e.g. letting an email code expire without waiting 10 minutes.
 *
 * Env: E2E_POSTGRES_CONTAINER (default referral-platform-prod-postgres-1), E2E_POSTGRES_USER /
 * E2E_POSTGRES_DB (default referral). `dbAvailable()` lets specs skip when Docker is not reachable.
 */
import { execFileSync } from 'node:child_process';

const container = process.env.E2E_POSTGRES_CONTAINER ?? 'referral-platform-prod-postgres-1';
const user = process.env.E2E_POSTGRES_USER ?? 'referral';
const database = process.env.E2E_POSTGRES_DB ?? 'referral';

/** Runs one SQL statement; returns psql's unaligned, tuples-only output. */
export function sql(statement: string): string {
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      container,
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      user,
      '-d',
      database,
      '-At',
      '-c',
      statement,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 },
  ).trim();
}

export function dbAvailable(): boolean {
  try {
    return sql('select 1') === '1';
  } catch {
    return false;
  }
}

/** SQL string literal. */
export function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
