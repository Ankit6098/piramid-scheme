import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import { loginAs } from './utils/factories';
import { adminClient, anotherSale, idemKey, parseCsv, saleScenario } from './finance-fixtures';

describe('ledger reads, summary and CSV exports', () => {
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

  /** Posts both rewards of sale 1 and reverses Anita's; sale 2 stays pending. */
  async function ledgerScenario(opts: Parameters<typeof saleScenario>[1] = {}) {
    const s = await saleScenario(t, opts);
    await anotherSale(t, s, 40_000n);
    const reviewer = await adminClient(t, ['FINANCE_REVIEWER']);
    for (const r of s.rewards) {
      await reviewer.client.post(`/api/v1/admin/rewards/${r.id}/approve`).set('Idempotency-Key', idemKey()).expect(200);
    }
    await reviewer.client
      .post(`/api/v1/admin/rewards/${s.rewards[1]!.id}/reverse`)
      .set('Idempotency-Key', idemKey())
      .send({ reason: 'Chargeback received from bank' })
      .expect(200);
    return { s, reviewer };
  }

  it('lists transactions with filters and shows entries', async () => {
    const { s, reviewer } = await ledgerScenario();
    const c = reviewer.client;

    const all = await c.get('/api/v1/admin/ledger/transactions');
    expect(all.status).toBe(200);
    expect(all.body.data).toHaveLength(3);
    expect(all.body.data[0]).toMatchObject({
      type: 'REWARD_REVERSAL',
      amountMinor: '5000',
      rewardUnit: 'MONEY',
      currencyCode: 'INR',
      currencyMinorUnits: 2,
      member: { id: s.anita.id, fullName: 'Anita Sharma' },
      program: { id: s.program.id },
      description: 'Chargeback received from bank',
      reward: { id: s.rewards[1]!.id, status: 'REVERSED', level: 2 },
    });
    const posting = all.body.data.find((x: { type: string; reward: { id: string } }) => x.type === 'REWARD_POSTING' && x.reward.id === s.rewards[1]!.id);
    expect(posting.reversedByTransactionId).toBe(all.body.data[0].id);
    expect(all.body.data[0].reversesTransactionId).toBe(posting.id);

    expect((await c.get('/api/v1/admin/ledger/transactions?type=REWARD_POSTING')).body.data).toHaveLength(2);
    expect((await c.get(`/api/v1/admin/ledger/transactions?memberId=${s.rahul.id}`)).body.data).toHaveLength(1);
    expect((await c.get(`/api/v1/admin/ledger/transactions?rewardId=${s.rewards[1]!.id}`)).body.data).toHaveLength(2);
    expect((await c.get('/api/v1/admin/ledger/transactions?from=2000-01-01&to=2000-01-02')).body.data).toHaveLength(0);
    const p1 = await c.get('/api/v1/admin/ledger/transactions?limit=2');
    const p2 = await c.get(`/api/v1/admin/ledger/transactions?limit=2&cursor=${p1.body.page.nextCursor}`);
    expect([...p1.body.data, ...p2.body.data].map((x: { id: string }) => x.id).sort()).toEqual(all.body.data.map((x: { id: string }) => x.id).sort());

    const detail = await c.get(`/api/v1/admin/ledger/transactions/${all.body.data[0].id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.entries.map((e: { direction: string; accountType: string; amountMinor: string }) => [e.direction, e.accountType, e.amountMinor])).toEqual([
      ['DEBIT', 'MEMBER_REWARDS_PAYABLE', '5000'],
      ['CREDIT', 'PLATFORM_REWARD_EXPENSE', '5000'],
    ]);
    expect(detail.body.data.entries[0].accountOwner).toEqual({ id: s.anita.id, fullName: 'Anita Sharma' });
    expect((await c.get('/api/v1/admin/ledger/transactions/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('shows account balances and per-unit totals (posted, reversed, outstanding liability)', async () => {
    const { s, reviewer } = await ledgerScenario();
    const c = reviewer.client;

    const accounts = await c.get('/api/v1/admin/ledger/accounts');
    expect(accounts.status).toBe(200);
    const byOwner = new Map(accounts.body.data.map((a: { owner: { id: string } | null }) => [a.owner?.id ?? 'platform', a]));
    expect(byOwner.get('platform')).toMatchObject({ type: 'PLATFORM_REWARD_EXPENSE', debitsMinor: '15000', creditsMinor: '5000', balanceMinor: '10000' });
    expect(byOwner.get(s.rahul.id)).toMatchObject({ type: 'MEMBER_REWARDS_PAYABLE', creditsMinor: '10000', debitsMinor: '0', balanceMinor: '10000' });
    expect(byOwner.get(s.anita.id)).toMatchObject({ creditsMinor: '5000', debitsMinor: '5000', balanceMinor: '0' });

    const nonZero = await c.get('/api/v1/admin/ledger/accounts?nonZero=true&type=MEMBER_REWARDS_PAYABLE');
    expect(nonZero.body.data.map((a: { owner: { id: string } }) => a.owner.id)).toEqual([s.rahul.id]);
    expect((await c.get(`/api/v1/admin/ledger/accounts?memberId=${s.anita.id}`)).body.data).toHaveLength(1);

    const summary = await c.get('/api/v1/admin/ledger/summary');
    expect(summary.body.data).toEqual({
      transactionCount: 3,
      buckets: [
        {
          rewardUnit: 'MONEY',
          currencyCode: 'INR',
          currencyMinorUnits: 2,
          postedMinor: '15000',
          postedCount: 2,
          reversedMinor: '5000',
          reversedCount: 1,
          outstandingLiabilityMinor: '10000',
          expenseMinor: '10000',
          memberAccounts: 2,
        },
      ],
    });
  });

  it('requires ledger:read (program admins and members are refused)', async () => {
    const { s } = await ledgerScenario();
    const programAdmin = await adminClient(t, ['PROGRAM_ADMIN'], { programScopes: [s.program.id] });
    for (const path of ['transactions', 'accounts', 'summary', 'export.csv']) {
      expect((await programAdmin.client.get(`/api/v1/admin/ledger/${path}`)).status).toBe(403);
    }
    expect((await (await loginAs(t, s.rahul)).get('/api/v1/admin/ledger/summary')).status).toBe(403);
  });

  it('exports ledger entries and rewards as CSV, neutralizing spreadsheet formulas, and audits the export', async () => {
    const { s, reviewer } = await ledgerScenario({ rahul: { fullName: '=HYPERLINK("http://evil.example","x")' } });

    const ledger = await reviewer.client.get('/api/v1/admin/ledger/export.csv');
    expect(ledger.status).toBe(200);
    expect(ledger.headers['content-type']).toMatch(/^text\/csv/);
    expect(ledger.headers['content-disposition']).toMatch(/filename="ledger-entries-\d{4}-\d{2}-\d{2}\.csv"/);
    const rows = parseCsv(ledger.text);
    expect(rows[0]![0]).toBe('transaction_id');
    expect(rows).toHaveLength(1 + 6); // 3 transactions × 2 entries
    const header = rows[0]!;
    const memberName = header.indexOf('member_name');
    const amount = header.indexOf('amount');
    expect(rows.slice(1).some((r) => r[memberName] === `'=HYPERLINK("http://evil.example","x")`)).toBe(true);
    expect(rows.slice(1).every((r) => !r[memberName]!.startsWith('='))).toBe(true);
    expect(new Set(rows.slice(1).map((r) => r[amount]))).toEqual(new Set(['100.00', '50.00']));
    expect(ledger.text).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);

    const rewards = await reviewer.client.get(`/api/v1/admin/rewards/export.csv?programId=${s.program.id}&status=POSTED`);
    expect(rewards.status).toBe(200);
    const rrows = parseCsv(rewards.text);
    expect(rrows).toHaveLength(2); // header + Rahul's posted reward
    const rh = rrows[0]!;
    expect(rrows[1]![rh.indexOf('recipient_name')]).toBe(`'=HYPERLINK("http://evil.example","x")`);
    expect(rrows[1]![rh.indexOf('amount')]).toBe('100.00');
    expect(rrows[1]![rh.indexOf('sale_amount')]).toBe('1000.00');

    expect(await t.prisma.auditLog.count({ where: { action: { in: ['ledger.export', 'rewards.export'] } } })).toBe(2);
  });

  it('refuses reward exports without reports:export', async () => {
    const { s } = await ledgerScenario();
    const programAdmin = await adminClient(t, ['PROGRAM_ADMIN'], { programScopes: [s.program.id] });
    const res = await programAdmin.client.get('/api/v1/admin/rewards/export.csv');
    expect(res.status).toBe(403);
    expect(res.body.error.details).toMatchObject({ missingPermissions: ['reports:export'] });
  });
});
