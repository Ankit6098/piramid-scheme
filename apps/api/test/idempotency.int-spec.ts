import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IdempotencyService } from '../src/common/idempotency/idempotency.service';
import { computeRequestHash, stableStringify } from '../src/common/idempotency/request-hash';
import { IdempotencyCleanupJob } from '../src/jobs/idempotency/idempotency-cleanup.job';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import { createUser, loginAs, type TestUser } from './utils/factories';
import { ProbeModule, probeCounters } from './utils/probe.module';

const H1 = computeRequestHash({ a: 1 });
const H2 = computeRequestHash({ a: 2 });

describe('request hashing', () => {
  it('is canonical: key order, undefined members and bigint representation do not matter', () => {
    expect(stableStringify({ b: 1, a: { d: 2n, c: undefined, e: [1, undefined] } })).toBe('{"a":{"d":"2","e":[1,null]},"b":1}');
    expect(computeRequestHash({ x: 1, y: 'z' })).toBe(computeRequestHash({ y: 'z', x: 1 }));
    expect(computeRequestHash({ x: 1 })).toMatch(/^[0-9a-f]{64}$/);
    expect(H1).not.toBe(H2);
  });
});

describe('IdempotencyService + @Idempotent()', () => {
  let t: TestApp;
  let svc: IdempotencyService;
  let user: TestUser;

  beforeAll(async () => {
    t = await createTestApp({ imports: [ProbeModule] });
    svc = t.get(IdempotencyService);
  });
  beforeEach(async () => {
    await resetDatabase();
    user = await createUser(t.prisma);
  });
  afterAll(async () => {
    await t?.close();
    await disconnectTestPrisma();
  });

  const scope = () => ({ actorUserId: user.id, key: 'key-0001', route: 'POST /x' });

  it('new → in progress (409 CONFLICT) → completed → replay', async () => {
    expect(await svc.begin({ ...scope(), requestHash: H1 })).toEqual({ state: 'new' });
    await expect(svc.begin({ ...scope(), requestHash: H1 })).rejects.toMatchObject({
      code: 'CONFLICT',
      httpStatus: 409,
      details: { retryable: true },
    });
    await svc.complete({ actorUserId: user.id, key: 'key-0001', status: 201, body: { data: { amountMinor: 5n } } });
    expect(await svc.begin({ ...scope(), requestHash: H1 })).toEqual({
      state: 'replay',
      status: 201,
      body: { data: { amountMinor: '5' } },
    });
    const row = await t.prisma.idempotencyKey.findUniqueOrThrow({ where: { actorUserId_key: { actorUserId: user.id, key: 'key-0001' } } });
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(24 * 3_600_000);
  });

  it('same key with a different request or route → 409 IDEMPOTENCY_CONFLICT; keys are scoped per actor', async () => {
    await svc.begin({ ...scope(), requestHash: H1 });
    await svc.complete({ actorUserId: user.id, key: 'key-0001', status: 200, body: { ok: true } });
    await expect(svc.begin({ ...scope(), requestHash: H2 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', httpStatus: 409 });
    await expect(svc.begin({ ...scope(), route: 'POST /y', requestHash: H1 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const other = await createUser(t.prisma);
    expect(await svc.begin({ actorUserId: other.id, key: 'key-0001', route: 'POST /x', requestHash: H2 })).toEqual({ state: 'new' });
  });

  it('release() lets a failed request be retried; expired and abandoned keys are reusable', async () => {
    await svc.begin({ ...scope(), requestHash: H1 });
    await svc.release({ actorUserId: user.id, key: 'key-0001' });
    expect(await svc.begin({ ...scope(), requestHash: H2 })).toEqual({ state: 'new' });

    // abandoned IN_PROGRESS (> 5 min): same request may take over, a different one may not
    await t.prisma.idempotencyKey.update({
      where: { actorUserId_key: { actorUserId: user.id, key: 'key-0001' } },
      data: { createdAt: new Date(Date.now() - 10 * 60_000) },
    });
    await expect(svc.begin({ ...scope(), requestHash: H1 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await svc.begin({ ...scope(), requestHash: H2 })).toEqual({ state: 'new' });

    // expired (24 h): reusable for anything; purge removes it
    await svc.complete({ actorUserId: user.id, key: 'key-0001', status: 200, body: null });
    await t.prisma.idempotencyKey.update({
      where: { actorUserId_key: { actorUserId: user.id, key: 'key-0001' } },
      data: { createdAt: new Date(Date.now() - 26 * 3_600_000), expiresAt: new Date(Date.now() - 2 * 3_600_000) },
    });
    expect(await svc.begin({ ...scope(), requestHash: H1 })).toEqual({ state: 'new' });
    await t.prisma.idempotencyKey.create({
      data: {
        actorUserId: user.id,
        key: 'old-key-1',
        route: 'POST /x',
        requestHash: H1,
        createdAt: new Date(Date.now() - 30 * 3_600_000),
        expiresAt: new Date(Date.now() - 6 * 3_600_000),
      },
    });
    expect(await t.get(IdempotencyCleanupJob).run()).toBe(1);
    expect(await t.prisma.idempotencyKey.count()).toBe(1);
  });

  it('execute() wraps begin/complete/release for non-HTTP callers', async () => {
    let runs = 0;
    const work = async () => ({ n: ++runs });
    const first = await svc.execute({ ...scope(), requestHash: H1 }, work);
    const second = await svc.execute({ ...scope(), requestHash: H1 }, work);
    expect(first).toEqual({ replayed: false, status: 200, body: { n: 1 } });
    expect(second).toEqual({ replayed: true, status: 200, body: { n: 1 } });
    await expect(svc.execute({ ...scope(), key: 'key-0002', requestHash: H1 }, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await t.prisma.idempotencyKey.count({ where: { key: 'key-0002' } })).toBe(0);
  });

  it('HTTP: replays the stored response without re-running the handler', async () => {
    const c = await loginAs(t, user);
    const before = probeCounters.idempotentRuns;
    const send = (client = c, ref = 'r1', body: Record<string, string> = { amountMinor: '5' }, key = 'op-key-123') =>
      client.post(`/api/v1/__probe/idempotent-op/${ref}`).set('Idempotency-Key', key).send(body);

    const first = await send().expect(201);
    expect(first.body.data).toMatchObject({ ref: 'r1', amountMinor: '5' });
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const replay = await send().expect(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(probeCounters.idempotentRuns).toBe(before + 1);

    expect((await send(c, 'r1', { amountMinor: '6' }).expect(409)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await send(c, 'r2').expect(409)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await c.post('/api/v1/__probe/idempotent-op/r1').send({ amountMinor: '5' }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');

    // another actor may use the same key independently
    const other = await loginAs(t, await createUser(t.prisma));
    const theirs = await send(other).expect(201);
    expect(theirs.body.data.opId).not.toBe(first.body.data.opId);
    expect(probeCounters.idempotentRuns).toBe(before + 2);
  });

  it('HTTP: failed requests are not stored, so a retry with the same key runs again', async () => {
    const c = await loginAs(t, user);
    const before = probeCounters.idempotentRuns;
    await c.post('/api/v1/__probe/idempotent-fail').set('Idempotency-Key', 'fail-key-1').expect(409);
    await c.post('/api/v1/__probe/idempotent-fail').set('Idempotency-Key', 'fail-key-1').expect(409);
    expect(probeCounters.idempotentRuns).toBe(before + 2);
    expect(await t.prisma.idempotencyKey.count()).toBe(0);
  });
});
