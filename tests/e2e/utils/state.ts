/**
 * Small persistent state for e2e runs against a long-lived stack (git-ignored, tests/e2e/.state/).
 *
 * An admin account enrolls its authenticator once; later runs (and later sign-ins in the same run)
 * need that TOTP secret and the last time-step used (the API rejects replays). Both are kept here,
 * keyed by email. Delete the directory together with the stack data (`down -v`).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const STATE_DIR = path.join(__dirname, '..', '.state');
const TOTP_FILE = path.join(STATE_DIR, 'totp.json');

interface TotpRecord {
  secret: string;
  lastStep: number | null;
}

type TotpState = Record<string, TotpRecord>;

function read(): TotpState {
  try {
    return JSON.parse(readFileSync(TOTP_FILE, 'utf8')) as TotpState;
  } catch {
    return {};
  }
}

function write(state: TotpState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${TOTP_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, TOTP_FILE);
}

export function getTotpRecord(email: string): TotpRecord | null {
  return read()[email.toLowerCase()] ?? null;
}

export function saveTotpRecord(email: string, record: TotpRecord): void {
  const state = read();
  state[email.toLowerCase()] = record;
  write(state);
}

/** Path for a Playwright storageState file of a signed-in actor. */
export function storageStatePath(name: string): string {
  mkdirSync(STATE_DIR, { recursive: true });
  return path.join(STATE_DIR, `${name}.storage.json`);
}
