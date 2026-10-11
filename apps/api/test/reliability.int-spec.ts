import { Controller, Get, Module, Query } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Public } from '../src/common/auth/decorators';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { normalizeError } from '../src/common/errors/all-exceptions.filter';
import { ok } from '../src/common/http/envelope';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { OutboxHandlerRegistry } from '../src/jobs/outbox/outbox-handler.registry';
import { OutboxRelay } from '../src/jobs/outbox/outbox-relay.service';
import { ProgramLifecycleService } from '../src/modules/programs/program-lifecycle.service';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase, testDatabaseUrl } from './utils/db';
import { createPolicy, createProgram, createUser, factoryAdmin, loginAs } from './utils/factories';

/**
 * Reliability under contention and partial outages (review findings R1, R2, R5, R8, R9): bounded
 * lock / statement / pool waits that fail with a retryable 503 instead of freezing the pool, UTC
 * sessions, rate limiting without Redis, scheduler transitions at the scheduled instant, and outbox
 * claim ownership across relays.
 */

@Controller('__fixc')
class ReliabilityProbeController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('sleep')
  async sleep(@Query('ms') ms: string) {
    await this.prisma.$executeRaw`SELECT pg_sleep(${String(Number(ms) / 1000)}::float8)`;
    return ok({ slept: Number(ms) });
  }

  @Public()
  @Get('ping')
  async ping() {
    await this.prisma.$queryRaw`SELECT 1`;
    return ok({ pong: true });
  }
}

@Module({ controllers: [ReliabilityProbeController] })
class ReliabilityProbeModule {}

const PASSWORD = 'Correct-Horse-42';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function lockHolder(sql: string, params: unknown[] = []): Promise<Client> {
  const holder = new Client({ connectionString: testDatabaseUrl() });
  await holder.connect();
  await holder.query('BEGIN');
  await holder.query(sql, params);
  return holder;
}

async function release(holder: Client): Promise<void> {
  await holder.query('COMMIT').catch(() => undefined);
  await holder.end();
}

async function waitingOnLocks(): Promise<number> {
  const c = new Client({ connectionString: testDatabaseUrl() });
  await c.connect();
  try {
    const r = await c.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
    );
    return r.rows[0].n as number;
  } finally {
    await c.end();
  }
}

describe('database sessions (default limits)', () => {
  let t: TestApp;
  beforeAll(async () => {
    await resetDatabase();
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
    await disconnectTestPrisma();
  });

  it('pins every pooled session to UTC with bounded statement and lock waits', async () => {
    const rows = await t.prisma.$queryRaw<Array<{ tz: string; st: string; lt: string; roundtrip: boolean; text: string }>>`
      SELECT current_setting('TimeZone') AS "tz", current_setting('statement_timeout') AS "st",
             current_setting('lock_timeout') AS "lt",
             (${new Date('2026-03-01T10:20:30.456Z')}::timestamptz = '2026-03-01T10:20:30.456Z'::timestamptz) AS "roundtrip",
             ${new Date('2026-03-01T10:20:30.456Z')}::timestamptz::text AS "text"`;
    expect(rows[0]).toEqual({ tz: 'UTC', st: '15s', lt: '5s', roundtrip: true, text: '2026-03-01 10:20:30.456+00' });
    await expect(t.prisma.assertUtcSession()).resolves.toBeUndefined();
  });

  it('registration behind a sponsor correction gives up after ~3 s with a retryable 503, then succeeds', async () => {
    const email = `reliability-${Date.now()}@example.test`;
    const c = t.client().withHeaders({ 'X-Forwarded-For': '198.19.7.1' });
    await c.post('/api/v1/auth/register').send({ fullName: 'Lock Waiter', email, password: PASSWORD }).expect(202);
    const ch = await t.prisma.emailChallenge.findFirstOrThrow({ where: { email, consumedAt: null }, orderBy: { createdAt: 'desc' } });
    const [msg] = await t.prisma.$queryRaw<Array<{ payload: { codeCiphertext: string } }>>`
      SELECT "payload" FROM "outbox_messages" WHERE "topic" = 'email.otp' AND "payload"->>'challengeId' = ${ch.id}`;
    const code = t.get(CryptoService).decryptOtpCode(msg!.payload.codeCiphertext, ch.id);

    // A sponsor correction holds the exclusive referral-tree lock.
    const holder = await lockHolder('SELECT pg_advisory_xact_lock(7301, 1)');
    try {
      const started = Date.now();
      const res = await c.post('/api/v1/auth/verify-email').send({ email, code, password: PASSWORD });
      const elapsed = Date.now() - started;
      expect(res.status).toBe(503);
      expect(res.body.error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', details: { retryable: true } });
      expect(elapsed).toBeGreaterThanOrEqual(2_500);
      expect(elapsed).toBeLessThan(8_000);
      // The connection was released instead of queueing behind the correction.
      expect(await waitingOnLocks()).toBe(0);
      expect(await t.prisma.user.count({ where: { email } })).toBe(0);
    } finally {
      await release(holder);
    }
    const ok = await c.post('/api/v1/auth/verify-email').send({ email, code, password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(await t.prisma.referralPath.count({ where: { descendant: { email } } })).toBe(1);
  });
});

describe('database sessions (tight limits)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({
      imports: [ReliabilityProbeModule],
      env: { DATABASE_POOL_MAX: '2', DATABASE_STATEMENT_TIMEOUT_MS: '1000', DATABASE_LOCK_TIMEOUT_MS: '500', DATABASE_CONNECT_TIMEOUT_MS: '400' },
    });
  });
  afterAll(async () => {
    await t?.close();
    await disconnectTestPrisma();
  });

  it('cancels a statement over statement_timeout and answers 503 (retryable)', async () => {
    const started = Date.now();
    const res = await t.client().get('/api/v1/__fixc/sleep?ms=5000');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', details: { retryable: true } });
    expect(Date.now() - started).toBeLessThan(3_000);
    await t.client().get('/api/v1/__fixc/sleep?ms=100').expect(200);
  });

  it('a row-lock wait over lock_timeout fails with 503 instead of holding the connection', async () => {
    const user = await createUser(t.prisma);
    const holder = await lockHolder('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [user.id]);
    try {
      const err = await t.prisma
        .runInTransaction((tx) => tx.$queryRaw`SELECT 1 FROM "users" WHERE "id" = ${user.id}::uuid FOR UPDATE`)
        .then(() => null, (e: unknown) => e);
      expect(normalizeError(err)).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE', details: { retryable: true }, unexpected: false });
    } finally {
      await release(holder);
    }
  });

  it('an exhausted pool fails fast with 503 instead of queueing every request', async () => {
    // supertest sends on then(): start both now.
    const busy = [t.client().get('/api/v1/__fixc/sleep?ms=900'), t.client().get('/api/v1/__fixc/sleep?ms=900')].map((r) => r.then((x) => x));
    await sleep(100);
    const started = Date.now();
    const res = await t.client().get('/api/v1/__fixc/ping');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', details: { retryable: true } });
    expect(Date.now() - started).toBeLessThan(800);
    // An interactive transaction that cannot get a connection in time (P2028) is a 503 too.
    const txErr = await t.prisma.runInTransaction(async () => 1, { maxWait: 100 }).then(() => null, (e: unknown) => e);
    if (txErr) expect(normalizeError(txErr)).toMatchObject({ status: 503, details: { retryable: true } });
    for (const r of await Promise.all(busy)) expect(r.status).toBe(200);
    await t.client().get('/api/v1/__fixc/ping').expect(200);
  });
});

describe('rate limiting while Redis is unreachable', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({
      imports: [ReliabilityProbeModule],
      env: { THROTTLE_STORAGE: 'redis', REDIS_URL: 'redis://127.0.0.1:6399', THROTTLE_DEFAULT_LIMIT: '5', TRUST_PROXY: 'true' },
    });
  });
  afterAll(async () => {
    await t?.close();
    await disconnectTestPrisma();
  });

  it('serves requests (e.g. /auth/csrf) and still enforces the limits per process', async () => {
    const started = Date.now();
    const csrf = await t.client().withHeaders({ 'X-Forwarded-For': '198.19.9.1' }).get('/api/v1/auth/csrf');
    expect(csrf.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(3_000);

    const c = t.client().withHeaders({ 'X-Forwarded-For': '198.19.9.2' });
    for (let i = 0; i < 5; i++) await c.get('/api/v1/__fixc/ping').expect(200);
    const limited = await c.get('/api/v1/__fixc/ping');
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    await t.client().withHeaders({ 'X-Forwarded-For': '198.19.9.3' }).get('/api/v1/__fixc/ping').expect(200);
  });
});

describe('scheduled program start', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await t?.close();
    await disconnectTestPrisma();
  });

  async function scheduledProgram(startsInMs: number) {
    const program = await createProgram(t.prisma, { status: 'SCHEDULED', startsAt: new Date(Date.now() + startsInMs) });
    await createPolicy(t.prisma, { programId: program.id, effectiveFrom: new Date(Date.now() - 30_000), requireActiveEnrollment: false });
    return program;
  }

  it('records SCHEDULED → ACTIVE at startsAt, so sales between the start and a late scheduler run count', async () => {
    await factoryAdmin(t.prisma);
    const admin = await loginAs(t, await createUser(t.prisma, { roles: ['SUPER_ADMIN'] }));
    const program = await scheduledProgram(1_500);
    const sponsor = await createUser(t.prisma);
    const subject = await createUser(t.prisma, { sponsor });
    await sleep(3_000); // the program started ~1.5 s ago; the scheduler has not run yet

    const sale = (externalId: string, supersedesEventId?: string) =>
      admin.post('/api/v1/admin/events').send({
        programId: program.id,
        type: 'PRODUCT_SALE',
        externalId,
        customerReference: 'C1',
        subjectUserId: subject.id,
        amountMinor: '100000',
        occurredAt: new Date(program.startsAt.getTime() + 500).toISOString(),
        ...(supersedesEventId ? { supersedesEventId } : {}),
      });
    // Recorded before the scheduler ran: the program was not active yet.
    const early = await sale('ORD-EARLY');
    expect(early.body.data.event.status).toBe('REJECTED');

    const run = await t.get(ProgramLifecycleService).applyScheduledTransitions(new Date());
    expect(run).toMatchObject({ started: [program.id], failed: [], busy: [] });
    const changes = await t.prisma.programStatusChange.findMany({ where: { programId: program.id }, orderBy: { changedAt: 'asc' } });
    expect(changes.map((c) => c.toStatus)).toEqual(['DRAFT', 'SCHEDULED', 'ACTIVE']);
    expect(changes[2]!.changedAt.toISOString()).toBe(program.startsAt.toISOString());

    // A sale that occurred after startsAt is accepted, and the early one can be re-recorded.
    const late = await sale('ORD-LATE');
    expect(late.body.data.event).toMatchObject({ status: 'PROCESSED' });
    const again = await sale('ORD-EARLY', early.body.data.event.id);
    expect(again.body.data.event.status).toBe('PROCESSED');
  });

  it('waits for a briefly share-locked program row instead of skipping it, and reports a busy row', async () => {
    await factoryAdmin(t.prisma);
    const program = await scheduledProgram(-1_000);
    // An enrollment holds the row FOR SHARE for a moment: the scheduler waits and starts it.
    const brief = await lockHolder('SELECT 1 FROM programs WHERE id = $1 FOR SHARE', [program.id]);
    setTimeout(() => void release(brief), 400);
    const run1 = await t.get(ProgramLifecycleService).applyScheduledTransitions(new Date());
    expect(run1.started).toEqual([program.id]);

    // A row locked longer than SCHEDULER_LOCK_TIMEOUT_MS is reported busy and retried next run.
    const other = await scheduledProgram(-1_000);
    const long = await lockHolder('SELECT 1 FROM programs WHERE id = $1 FOR SHARE', [other.id]);
    let run2;
    try {
      run2 = await t.get(ProgramLifecycleService).applyScheduledTransitions(new Date());
    } finally {
      await release(long);
    }
    expect(run2).toMatchObject({ started: [], failed: [], busy: [other.id] });
    expect((await t.prisma.program.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('SCHEDULED');
    const run3 = await t.get(ProgramLifecycleService).applyScheduledTransitions(new Date());
    expect(run3.started).toEqual([other.id]);
  });

  it('a manual transition is always logged at now()', async () => {
    const program = await createProgram(t.prisma, { status: 'ACTIVE' });
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.status_changed_at', '2000-01-01T00:00:00Z', true)`;
      await tx.program.update({ where: { id: program.id }, data: { status: 'PAUSED' } });
    });
    const paused = await t.prisma.programStatusChange.findFirstOrThrow({ where: { programId: program.id, toStatus: 'PAUSED' } });
    expect(Math.abs(paused.changedAt.getTime() - Date.now())).toBeLessThan(10_000);
  });
});

describe('outbox relay claim ownership', () => {
  let t: TestApp;
  beforeAll(async () => {
    await resetDatabase();
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
    await disconnectTestPrisma();
  });

  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((r) => (open = r));
    return { open, opened };
  }

  it('a relay whose claim was reclaimed as stale cannot turn the other relay\'s SENT into FAILED', async () => {
    const registry = t.get(OutboxHandlerRegistry);
    const relayA = t.get(OutboxRelay);
    const relayB = new OutboxRelay(t.prisma, registry, { role: 'worker', processing: false });
    const aEntered = gate();
    const aRelease = gate();
    const bEntered = gate();
    const bRelease = gate();
    let calls = 0;
    registry.register('zz.fixc.reclaim' as never, {
      handle: async () => {
        calls += 1;
        if (calls === 1) {
          aEntered.open();
          await aRelease.opened;
          throw new Error('transient failure on relay A');
        }
        bEntered.open();
        await bRelease.opened;
      },
    });
    const msg = await t.prisma.outboxMessage.create({ data: { topic: 'zz.fixc.reclaim', payload: { n: 1 } } });
    const runA = relayA.runOnce(1);
    await aEntered.opened;
    // Relay A has been stuck for longer than the stale-lock timeout: relay B reclaims the row.
    await t.prisma.$executeRaw`UPDATE "outbox_messages" SET "locked_at" = now() - interval '6 minutes' WHERE "id" = ${msg.id}::uuid`;
    const runB = relayB.runOnce(1);
    await bEntered.opened;
    aRelease.open();
    expect(await runA).toMatchObject({ claimed: 1, failed: 0, lost: 1 });
    expect(await t.prisma.outboxMessage.findUniqueOrThrow({ where: { id: msg.id } })).toMatchObject({ status: 'PROCESSING', attempts: 2 });
    bRelease.open();
    expect(await runB).toMatchObject({ claimed: 1, sent: 1, lost: 0 });
    expect(await t.prisma.outboxMessage.findUniqueOrThrow({ where: { id: msg.id } })).toMatchObject({ status: 'SENT', attempts: 2, lastError: null });
    expect(calls).toBe(2);
  });

  it('rows queued behind a slow one in the same batch are not dispatched again after a reclaim', async () => {
    const registry = t.get(OutboxHandlerRegistry);
    const relayA = t.get(OutboxRelay);
    const relayB = new OutboxRelay(t.prisma, registry, { role: 'worker', processing: false });
    const firstEntered = gate();
    const firstRelease = gate();
    const calls: Record<string, number> = {};
    registry.register('zz.fixc.batch' as never, {
      handle: async (m: { payload: unknown }) => {
        const key = (m.payload as { k: string }).k;
        calls[key] = (calls[key] ?? 0) + 1;
        if (key === 'first' && calls[key] === 1) {
          firstEntered.open();
          await firstRelease.opened;
        }
      },
    });
    const first = await t.prisma.outboxMessage.create({ data: { topic: 'zz.fixc.batch', payload: { k: 'first' }, availableAt: new Date(Date.now() - 2_000) } });
    const second = await t.prisma.outboxMessage.create({ data: { topic: 'zz.fixc.batch', payload: { k: 'second' }, availableAt: new Date(Date.now() - 1_000) } });
    const runA = relayA.runOnce(2);
    await firstEntered.opened;
    // The second row (claimed by A, not yet dispatched) looks stale: B reclaims and delivers it.
    await t.prisma.$executeRaw`UPDATE "outbox_messages" SET "locked_at" = now() - interval '6 minutes' WHERE "id" = ${second.id}::uuid`;
    expect(await relayB.runOnce(5)).toMatchObject({ claimed: 1, sent: 1 });
    firstRelease.open();
    expect(await runA).toMatchObject({ claimed: 2, sent: 1, lost: 1 });
    expect(calls).toEqual({ first: 1, second: 1 });
    for (const id of [first.id, second.id]) {
      expect((await t.prisma.outboxMessage.findUniqueOrThrow({ where: { id } })).status).toBe('SENT');
    }
  });
});

describe('keyset pagination', () => {
  let t: TestApp;
  beforeAll(async () => {
    await resetDatabase();
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
    await disconnectTestPrisma();
  });

  it('walks rows that share a timestamp exactly once, newest first', async () => {
    const user = await createUser(t.prisma);
    const at = new Date('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < 7; i++) {
      await t.prisma.notification.create({
        data: { userId: user.id, type: 'test.keyset', title: `n${i}`, body: 'b', createdAt: i < 5 ? at : new Date(at.getTime() + i * 1000) },
      });
    }
    const expected = (await t.prisma.notification.findMany({ where: { userId: user.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })).map((n) => n.id);
    const client = await loginAs(t, user);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await client.get(`/api/v1/users/me/notifications?limit=2${cursor ? `&cursor=${cursor}` : ''}`).expect(200);
      seen.push(...res.body.data.map((n: { id: string }) => n.id));
      cursor = res.body.page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(expected);
  });
});
