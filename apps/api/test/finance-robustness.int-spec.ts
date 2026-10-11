/**
 * Robustness of finance mutations — regression tests for the adversarial-review findings R6
 * (settings read outside the decision transaction exhausted the pool on a cold cache) and R13 (a
 * failed idempotency `complete()` after a committed handler released the key, so a retry ran the
 * handler again).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdempotencyService } from '../src/common/idempotency/idempotency.service';
import { PlatformSettingsService } from '../src/common/settings/platform-settings.service';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import { createUser, loginAs, type TestUser } from './utils/factories';
import { ProbeModule, probeCounters } from './utils/probe.module';
import { adminClient, anotherSale, idemKey, saleScenario } from './finance-fixtures';

describe('finance robustness', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ imports: [ProbeModule] });
  });
  beforeEach(async () => {
    await resetDatabase();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await t?.close();
    await disconnectTestPrisma();
  });

  describe('R6 — reward decisions read settings through their own transaction', () => {
    it('approves as many rewards concurrently as the pool has connections, on a cold settings cache', async () => {
      const s = await saleScenario(t);
      const second = await anotherSale(t, s);
      const ids = [...s.rewards.map((r) => r.id), ...second.rewards.map((r) => r.id)];
      expect(ids).toHaveLength(t.config.database.poolMax); // 4 in tests
      const { client } = await adminClient(t, ['FINANCE_REVIEWER']);
      await client.get('/api/v1/admin/rewards').expect(200); // warm the session, not the settings

      t.get(PlatformSettingsService).invalidate();
      const results = await Promise.all(
        ids.map((id) => client.post(`/api/v1/admin/rewards/${id}/approve`).set('Idempotency-Key', idemKey())),
      );
      expect(results.map((r) => r.status), JSON.stringify(results.map((r) => r.body))).toEqual(ids.map(() => 200));
      expect(await t.prisma.reward.count({ where: { id: { in: ids }, status: 'POSTED' } })).toBe(ids.length);
    });

    it('rejections and sale reversals also notify through the transaction', async () => {
      const s = await saleScenario(t);
      const { client } = await adminClient(t, ['FINANCE_REVIEWER']);
      const settings = t.get(PlatformSettingsService);
      const spy = vi.spyOn(settings, 'get');
      await client
        .post(`/api/v1/admin/rewards/${s.rewards[0]!.id}/reject`)
        .set('Idempotency-Key', idemKey())
        .send({ reason: 'Not a verifiable sale' })
        .expect(200);
      await client.post(`/api/v1/admin/events/${s.eventId}/reverse`).set('Idempotency-Key', idemKey()).send({ reason: 'Chargeback from the bank' }).expect(200);
      expect(spy).toHaveBeenCalled();
      // Every read during the decisions went through a transaction client (never the pool).
      expect(spy.mock.calls.every(([db]) => db !== undefined)).toBe(true);
    });
  });

  describe('R13 — a committed handler is never re-run when storing its response fails', () => {
    let user: TestUser;
    beforeEach(async () => {
      user = await createUser(t.prisma);
    });

    const send = (c: Awaited<ReturnType<typeof loginAs>>, key: string) =>
      c.post('/api/v1/__probe/idempotent-op/r1').set('Idempotency-Key', key).send({ amountMinor: '5' });

    it('returns the handler response and keeps the key when complete() keeps failing', async () => {
      const c = await loginAs(t, user);
      const svc = t.get(IdempotencyService);
      vi.spyOn(svc, 'complete').mockRejectedValue(new Error('connection reset'));
      const before = probeCounters.idempotentRuns;

      const first = await send(c, 'r13-key-0001');
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.body.data).toMatchObject({ ref: 'r1', amountMinor: '5' });
      expect(probeCounters.idempotentRuns).toBe(before + 1);
      const row = await t.prisma.idempotencyKey.findUniqueOrThrow({ where: { actorUserId_key: { actorUserId: user.id, key: 'r13-key-0001' } } });
      expect(row.status).toBe('IN_PROGRESS');

      // A retry with the same key must not run the handler again.
      const retry = await send(c, 'r13-key-0001');
      expect(retry.status).toBe(409);
      expect(retry.body.error).toMatchObject({ code: 'CONFLICT', details: { retryable: true } });
      expect(probeCounters.idempotentRuns).toBe(before + 1);
    });

    it('stores the response on the best-effort retry, so the next retry is a replay', async () => {
      const c = await loginAs(t, user);
      const svc = t.get(IdempotencyService);
      vi.spyOn(svc, 'complete').mockRejectedValueOnce(new Error('connection reset'));
      const before = probeCounters.idempotentRuns;

      const first = await send(c, 'r13-key-0002');
      expect(first.status).toBe(201);
      const replay = await send(c, 'r13-key-0002');
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect(probeCounters.idempotentRuns).toBe(before + 1);
    });

    it('handler errors still release the key (nothing was committed)', async () => {
      const c = await loginAs(t, user);
      const before = probeCounters.idempotentRuns;
      await c.post('/api/v1/__probe/idempotent-fail').set('Idempotency-Key', 'r13-fail-0001').expect(409);
      await c.post('/api/v1/__probe/idempotent-fail').set('Idempotency-Key', 'r13-fail-0001').expect(409);
      expect(probeCounters.idempotentRuns).toBe(before + 2);
      expect(await t.prisma.idempotencyKey.count({ where: { key: 'r13-fail-0001' } })).toBe(0);
    });

    it('execute(): a failed complete() after the work does not release the key', async () => {
      const svc = t.get(IdempotencyService);
      vi.spyOn(svc, 'complete').mockRejectedValue(new Error('connection reset'));
      let runs = 0;
      const input = { actorUserId: user.id, key: 'r13-exec-0001', route: 'POST /x', requestHash: 'a'.repeat(64) };
      await expect(svc.execute(input, async () => ({ n: ++runs }))).resolves.toEqual({ replayed: false, status: 200, body: { n: 1 } });
      await expect(svc.execute(input, async () => ({ n: ++runs }))).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(runs).toBe(1);
    });
  });
});
