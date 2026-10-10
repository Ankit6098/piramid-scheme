import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import { loginAs } from './utils/factories';
import { adminClient, anotherSale, idemKey, parseCsv, saleScenario } from './finance-fixtures';

/** Exactly the fields business rules §10 allows a member to see. */
const MEMBER_REWARD_KEYS = [
  'amountMinor',
  'approvedDate',
  'createdDate',
  'currencyCode',
  'currencyMinorUnits',
  'id',
  'level',
  'postedDate',
  'program',
  'rejectedDate',
  'rejectionReason',
  'reversalReason',
  'reversedDate',
  'rewardUnit',
  'status',
];

describe('member rewards and earnings (/users/me)', () => {
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

  /** Rahul ends up with: one POSTED, one REVERSED, one REJECTED and one PENDING reward. */
  async function rahulHistory() {
    const s = await saleScenario(t);
    const sale2 = await anotherSale(t, s, 50_000n); // Rahul 5000
    const sale3 = await anotherSale(t, s, 30_000n); // Rahul 3000
    const sale4 = await anotherSale(t, s, 20_000n); // Rahul 2000 (stays pending)
    const { client } = await adminClient(t, ['FINANCE_REVIEWER']);
    const rahulReward = (rewards: Array<{ id: string; recipientUserId: string }>) => rewards.find((r) => r.recipientUserId === s.rahul.id)!.id;
    const posted = s.rewards[0]!.id;
    const reversed = rahulReward(sale2.rewards);
    const rejected = rahulReward(sale3.rewards);
    const pending = rahulReward(sale4.rewards);
    await client.post(`/api/v1/admin/rewards/${posted}/approve`).set('Idempotency-Key', idemKey()).expect(200);
    await client.post(`/api/v1/admin/rewards/${reversed}/approve`).set('Idempotency-Key', idemKey()).expect(200);
    await client.post(`/api/v1/admin/rewards/${reversed}/reverse`).set('Idempotency-Key', idemKey()).send({ reason: 'Refund issued to the customer' }).expect(200);
    await client.post(`/api/v1/admin/rewards/${rejected}/reject`).set('Idempotency-Key', idemKey()).send({ reason: 'Sale could not be verified' }).expect(200);
    return { s, posted, reversed, rejected, pending };
  }

  it('lists only the member’s own rewards with the §10 fields and nothing about the sale', async () => {
    const { s, posted, rejected } = await rahulHistory();
    const rahul = await loginAs(t, s.rahul);
    const res = await rahul.get('/api/v1/users/me/rewards');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(4);
    for (const r of res.body.data) {
      expect(Object.keys(r).sort()).toEqual(MEMBER_REWARD_KEYS);
      expect(Object.keys(r.program).sort()).toEqual(['id', 'name']);
      expect(r.createdDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const body = JSON.stringify(res.body);
    for (const secret of [s.priya.id, 'Priya', '100000', s.eventId, 'trace', 'customerReference', 'externalId', 'occurredAt']) {
      expect(body).not.toContain(secret);
    }
    const postedRow = res.body.data.find((r: { id: string }) => r.id === posted);
    expect(postedRow).toMatchObject({ status: 'POSTED', amountMinor: '10000', rewardUnit: 'MONEY', currencyCode: 'INR', level: 1 });
    expect(postedRow.postedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.data.find((r: { id: string }) => r.id === rejected)).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'Sale could not be verified',
    });

    const filtered = await rahul.get('/api/v1/users/me/rewards?status=PENDING_APPROVAL');
    expect(filtered.body.data).toHaveLength(1);
    const byProgram = await rahul.get(`/api/v1/users/me/rewards?programId=${s.program.id}&limit=2`);
    expect(byProgram.body.data).toHaveLength(2);
    expect(byProgram.body.page.nextCursor).toEqual(expect.any(String));

    const facets = await rahul.get('/api/v1/users/me/rewards/facets');
    expect(facets.body.data).toEqual({ programs: [{ id: s.program.id, name: 'Spring Promo' }] });

    // Anita sees only her own; Priya (the subject) sees none.
    expect((await (await loginAs(t, s.anita)).get('/api/v1/users/me/rewards')).body.data).toHaveLength(4);
    expect((await (await loginAs(t, s.priya)).get('/api/v1/users/me/rewards')).body.data).toEqual([]);
  });

  it('returns 404 for someone else’s reward and 401 without a session', async () => {
    const { s, posted } = await rahulHistory();
    const anita = await loginAs(t, s.anita);
    expect((await anita.get(`/api/v1/users/me/rewards/${posted}`)).status).toBe(404);
    const own = await (await loginAs(t, s.rahul)).get(`/api/v1/users/me/rewards/${posted}`);
    expect(own.status).toBe(200);
    expect(Object.keys(own.body.data).sort()).toEqual(MEMBER_REWARD_KEYS);
    expect((await t.client().get('/api/v1/users/me/rewards')).status).toBe(401);
    expect((await t.client().get('/api/v1/users/me/earnings')).status).toBe(401);
  });

  it('earned to date = posted − reversed (ledger); pending and reversed totals; rejected never counted', async () => {
    const { s } = await rahulHistory();
    const res = await (await loginAs(t, s.rahul)).get('/api/v1/users/me/earnings');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      buckets: [
        {
          rewardUnit: 'MONEY',
          currencyCode: 'INR',
          currencyMinorUnits: 2,
          earnedToDateMinor: '10000', // 10000 + 5000 posted − 5000 reversed
          pendingMinor: '2000',
          reversedMinor: '5000',
          postedCount: 1,
          pendingCount: 1,
          reversedCount: 1,
        },
      ],
    });
    // A member without rewards gets no buckets.
    expect((await (await loginAs(t, s.priya)).get('/api/v1/users/me/earnings')).body.data).toEqual({ buckets: [] });
  });

  it('exports the member’s own rewards as CSV without sale details', async () => {
    const { s } = await rahulHistory();
    const res = await (await loginAs(t, s.rahul)).get('/api/v1/users/me/rewards/export.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="my-rewards-\d{4}-\d{2}-\d{2}\.csv"/);
    const rows = parseCsv(res.text);
    expect(rows[0]).toEqual([
      'reward_id',
      'date',
      'program',
      'level',
      'amount',
      'reward_unit',
      'currency_code',
      'status',
      'approved_date',
      'posted_date',
      'rejected_date',
      'reversed_date',
      'rejection_reason',
      'reversal_reason',
    ]);
    expect(rows).toHaveLength(5);
    expect(rows.slice(1).map((r) => r[4]).sort()).toEqual(['100.00', '20.00', '30.00', '50.00']);
    expect(res.text).not.toContain(s.priya.id);
  });
});
