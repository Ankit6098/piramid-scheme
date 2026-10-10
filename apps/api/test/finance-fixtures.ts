/**
 * Shared fixtures for the finance integration suites (rewards, ledger, reconciliation, event
 * reversal). Builds a processed sale through the real RewardEngineService:
 *
 *   Anita (L2) > Rahul (L1) > Priya (subject)  — program with a 10 % / 5 % policy (approval required)
 *
 * A ₹1,000.00 sale (100000 minor) recorded by the factory SUPER_ADMIN yields two PENDING_APPROVAL
 * rewards: Rahul 10000, Anita 5000.
 */
import { randomUUID } from 'node:crypto';
import type { RoleKey } from '@app/shared';
import { RewardEngineService } from '../src/modules/rewards/reward-engine.service';
import type { TestApp } from './utils/app';
import {
  createEnrollment,
  createEvent,
  createPolicy,
  createProgram,
  createUser,
  factoryAdmin,
  loginAs,
  type CreateUserOptions,
  type LoggedInClient,
  type TestUser,
} from './utils/factories';

export interface SaleScenario {
  program: Awaited<ReturnType<typeof createProgram>>;
  policyId: string;
  anita: TestUser;
  rahul: TestUser;
  priya: TestUser;
  eventId: string;
  /** [level 1 → Rahul 10000, level 2 → Anita 5000] */
  rewards: Array<{ id: string; level: number; recipientUserId: string; amountMinor: bigint }>;
}

export interface ScenarioOptions {
  /** Extra options for the users (e.g. give Rahul the FINANCE_REVIEWER role). */
  anita?: CreateUserOptions;
  rahul?: CreateUserOptions;
  amountMinor?: bigint;
  programName?: string;
}

export async function saleScenario(t: TestApp, opts: ScenarioOptions = {}): Promise<SaleScenario> {
  await factoryAdmin(t.prisma);
  const anita = await createUser(t.prisma, { fullName: 'Anita Sharma', ...opts.anita });
  const rahul = await createUser(t.prisma, { fullName: 'Rahul Verma', ...opts.rahul, sponsor: anita });
  const priya = await createUser(t.prisma, { fullName: 'Priya Nair', sponsor: rahul });
  const program = await createProgram(t.prisma, { name: opts.programName ?? 'Spring Promo' });
  const policy = await createPolicy(t.prisma, { programId: program.id });
  await createEnrollment(t.prisma, { userId: anita.id, programId: program.id });
  await createEnrollment(t.prisma, { userId: rahul.id, programId: program.id });
  const event = await createEvent(t.prisma, {
    programId: program.id,
    subjectUserId: priya.id,
    amountMinor: opts.amountMinor ?? 100_000n,
  });
  await t.get(RewardEngineService).processEvent(event.id);
  const rewards = await t.prisma.reward.findMany({
    where: { eventId: event.id },
    orderBy: { level: 'asc' },
    select: { id: true, level: true, recipientUserId: true, amountMinor: true },
  });
  return { program, policyId: policy.id, anita, rahul, priya, eventId: event.id, rewards };
}

/** Another processed sale in the same program (subject Priya → rewards for Rahul and Anita). */
export async function anotherSale(t: TestApp, s: SaleScenario, amountMinor = 50_000n) {
  const event = await createEvent(t.prisma, { programId: s.program.id, subjectUserId: s.priya.id, amountMinor });
  await t.get(RewardEngineService).processEvent(event.id);
  const rewards = await t.prisma.reward.findMany({ where: { eventId: event.id }, orderBy: { level: 'asc' } });
  return { eventId: event.id, rewards };
}

export async function adminClient(
  t: TestApp,
  roles: RoleKey[],
  opts: Omit<CreateUserOptions, 'roles'> = {},
): Promise<{ user: TestUser; client: LoggedInClient }> {
  const user = await createUser(t.prisma, { ...opts, roles });
  return { user, client: await loginAs(t, user) };
}

export const idemKey = () => `test-${randomUUID()}`;

/** Ledger transactions of a reward, oldest first. */
export function ledgerOf(t: TestApp, rewardId: string) {
  return t.prisma.ledgerTransaction.findMany({
    where: { rewardId },
    include: { entries: { include: { account: true } } },
    orderBy: { postedAt: 'asc' },
  });
}

/** Parses a CSV body produced by the exports (handles quotes; strips the BOM). */
export function parseCsv(text: string): string[][] {
  const body = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && body[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
