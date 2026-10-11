import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CORRECTION_LIMITS } from '../src/modules/referrals/sponsor-correction.service';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase, testDatabaseUrl } from './utils/db';
import { createUser, factoryAdmin, loginAs, type TestUser } from './utils/factories';

/**
 * Commit-time referral closure consistency after migration 20261011110000 (statement-level queueing,
 * one deferred check per touched member) and the statement-level referral_paths guards: the same
 * violations as before must still be refused, and a large correction must be fast.
 */

async function rawClient(): Promise<Client> {
  const url = new URL(testDatabaseUrl());
  url.search = '';
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  return client;
}

/** Runs a whole script (simple-query protocol) that must fail; returns SQLSTATE + message. */
async function mustFail(client: Client, script: string): Promise<{ code: string; message: string }> {
  let error: { code?: string; message?: string } | null = null;
  try {
    await client.query(script);
  } catch (e) {
    error = e as { code?: string; message?: string };
  }
  await client.query('ROLLBACK');
  if (!error) throw new Error('the database accepted an inconsistent referral tree');
  return { code: String(error.code), message: String(error.message) };
}

/** BEGIN; exclusive tree lock; correction row; SET LOCAL id; <body>; COMMIT */
function correction(member: TestUser, newSponsor: TestUser, admin: TestUser, body: string): string {
  const id = randomUUID();
  return `BEGIN;
    SELECT pg_advisory_xact_lock(7301, 1);
    INSERT INTO referral_corrections (id, child_user_id, previous_sponsor_id, new_sponsor_id, reason, performed_by_id)
      VALUES ('${id}', '${member.id}', ${member.sponsorId ? `'${member.sponsorId}'` : 'NULL'}, '${newSponsor.id}', 'consistency regression test', '${admin.id}');
    SELECT set_config('app.referral_correction_id', '${id}', true);
    ${body};
    COMMIT;`;
}

const relink = (member: TestUser, newSponsor: TestUser) => `
  UPDATE referral_relationships SET sponsor_user_id = '${newSponsor.id}', referral_code_id = NULL, source = 'ADMIN_CORRECTION'
   WHERE child_user_id = '${member.id}'`;
const detach = (member: TestUser) => `
  DELETE FROM referral_paths p USING referral_paths up, referral_paths sub
   WHERE up.descendant_id = '${member.id}' AND up.depth > 0 AND sub.ancestor_id = '${member.id}'
     AND p.ancestor_id = up.ancestor_id AND p.descendant_id = sub.descendant_id`;
const attach = (member: TestUser, newSponsor: TestUser) => `
  INSERT INTO referral_paths (ancestor_id, descendant_id, depth)
  SELECT up.ancestor_id, sub.descendant_id, up.depth + sub.depth + 1
    FROM referral_paths up JOIN referral_paths sub ON sub.ancestor_id = '${member.id}'
   WHERE up.descendant_id = '${newSponsor.id}'`;

describe('referral closure consistency (deferred, once per member)', () => {
  let t: TestApp;
  let client: Client;
  let admin: TestUser;
  let a: TestUser;
  let b: TestUser;
  let c: TestUser;
  let d: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
    client = await rawClient();
  });
  beforeEach(async () => {
    await resetDatabase();
    admin = await factoryAdmin(t.prisma);
    a = await createUser(t.prisma);
    b = await createUser(t.prisma, { sponsor: a });
    c = await createUser(t.prisma, { sponsor: b }); // a → b → c
    d = await createUser(t.prisma); // another root
  });
  afterEach(async () => {
    expect((await client.query('SELECT count(*)::int AS n FROM app_private.referral_pending_checks')).rows[0].n).toBe(0);
  });
  afterAll(async () => {
    await client?.end();
    await t?.close();
    await disconnectTestPrisma();
  });

  it('accepts a complete correction (relink + detach + attach) and leaves no queued checks', async () => {
    await client.query(correction(b, d, admin, [relink(b, d), detach(b), attach(b, d)].join(';')));
    const paths = await t.prisma.referralPath.findMany({ where: { descendantId: c.id }, orderBy: { depth: 'asc' } });
    expect(paths.map((p) => [p.ancestorId, p.depth])).toEqual([
      [c.id, 0],
      [b.id, 1],
      [d.id, 2],
    ]);
  });

  it('refuses at COMMIT a correction that relinks the sponsor but keeps the old closure rows', async () => {
    const err = await mustFail(client, correction(b, d, admin, relink(b, d)));
    expect(err).toMatchObject({ code: '23001' });
    expect(err.message).toMatch(/do not match its sponsor chain/);
  });

  it('refuses at COMMIT a correction that detaches the subtree without attaching it', async () => {
    const err = await mustFail(client, correction(b, d, admin, [relink(b, d), detach(b)].join(';')));
    expect(err.message).toMatch(/do not match its sponsor chain/);
  });

  it('refuses at COMMIT closure rows that disagree for a member below the moved one', async () => {
    const body = [relink(b, d), detach(b), attach(b, d), `DELETE FROM referral_paths WHERE ancestor_id = '${d.id}' AND descendant_id = '${c.id}'`].join(';');
    const err = await mustFail(client, correction(b, d, admin, body));
    expect(err.message).toMatch(/do not match its sponsor chain/);
  });

  it('re-checks members changed after an intermediate SET CONSTRAINTS ALL IMMEDIATE', async () => {
    const body = [
      relink(b, d),
      detach(b),
      attach(b, d),
      'SET CONSTRAINTS ALL IMMEDIATE',
      'SET CONSTRAINTS ALL DEFERRED',
      `DELETE FROM referral_paths WHERE ancestor_id = '${d.id}' AND descendant_id = '${c.id}'`,
    ].join(';');
    const err = await mustFail(client, correction(b, d, admin, body));
    expect(err.message).toMatch(/do not match its sponsor chain/);
  });

  it('refuses at COMMIT a registration that skips its ancestor rows', async () => {
    const id = randomUUID();
    const err = await mustFail(
      client,
      `BEGIN;
       INSERT INTO users (id, full_name, email, status, email_verified_at, updated_at) VALUES ('${id}', 'New Member', 'new-${id}@example.test', 'ACTIVE', now(), now());
       SELECT pg_advisory_xact_lock_shared(7301, 1);
       INSERT INTO referral_paths VALUES ('${id}', '${id}', 0);
       INSERT INTO referral_relationships (id, child_user_id, sponsor_user_id, referral_code_id, updated_at)
         VALUES (gen_random_uuid(), '${id}', '${c.id}', '${c.referralCodeId}', now());
       COMMIT;`,
    );
    expect(err.message).toMatch(/do not match its sponsor chain/);
  });

  it('refuses closure UPDATE and DELETE outside a correction (statement guard); no-op statements pass', async () => {
    const upd = await mustFail(client, `BEGIN; UPDATE referral_paths SET depth = depth WHERE descendant_id = '${c.id}' AND depth = 1; COMMIT;`);
    expect(upd).toMatchObject({ code: '23001' });
    expect(upd.message).toMatch(/immutable outside the audited correction workflow/);
    const del = await mustFail(client, `BEGIN; DELETE FROM referral_paths WHERE descendant_id = '${c.id}' AND depth = 2; COMMIT;`);
    expect(del.message).toMatch(/immutable outside the audited correction workflow/);
    await client.query(`BEGIN; DELETE FROM referral_paths WHERE descendant_id = '${randomUUID()}'; COMMIT;`);
  });

  it('a stray correction id authorizes nothing: closure inserts still follow the registration rules', async () => {
    const err = await mustFail(
      client,
      `BEGIN;
       SELECT pg_advisory_xact_lock(7301, 1);
       SELECT set_config('app.referral_correction_id', '${randomUUID()}', true);
       INSERT INTO referral_paths VALUES ('${d.id}', '${c.id}', 3);
       COMMIT;`,
    );
    expect(err).toMatchObject({ code: '23001' });
    expect(err.message).toMatch(/only written by the registration/);
  });

  it('refuses a correction above the closure-row cap with CORRECTION_TOO_LARGE', async () => {
    const su = await loginAs(t, await createUser(t.prisma, { roles: ['SUPER_ADMIN'] }));
    const saved = CORRECTION_LIMITS.maxClosureRows;
    CORRECTION_LIMITS.maxClosureRows = 3; // b's subtree (2 members) × (1 old ancestor + 1 new chain row) = 4
    try {
      const res = await su.post(`/api/v1/admin/members/${b.id}/sponsor-correction`).send({ newSponsorId: d.id, reason: 'move the whole team over' });
      expect(res.status).toBe(409);
      expect(res.body.error.details).toMatchObject({ reason: 'CORRECTION_TOO_LARGE', affectedMembers: 2, closureRows: 4, limit: 3 });
    } finally {
      CORRECTION_LIMITS.maxClosureRows = saved;
    }
    expect((await t.prisma.referralRelationship.findUniqueOrThrow({ where: { childUserId: b.id } })).sponsorUserId).toBe(a.id);
  });

  it('moves a 1 000-member subtree in seconds and every moved member stays consistent', async () => {
    const su = await loginAs(t, await createUser(t.prisma, { roles: ['SUPER_ADMIN'] }));
    // 1 000 members below c (ternary tree), generated in one transaction like 1 000 registrations.
    await t.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = 0`;
        await tx.$executeRawUnsafe(`
          DO $$
          DECLARE ids uuid[] := ARRAY['${c.id}'::uuid]; i int; parent uuid; uid uuid; code_id uuid;
          BEGIN
            PERFORM pg_advisory_xact_lock_shared(7301, 1);
            FOR i IN 1..1000 LOOP
              parent := ids[((i - 1) / 3) + 1];
              uid := gen_random_uuid();
              INSERT INTO users (id, full_name, email, email_verified_at, status, created_at, updated_at)
                VALUES (uid, 'Gen ' || i, 'gen' || i || '-' || uid || '@example.test', now(), 'ACTIVE', now(), now());
              INSERT INTO referral_paths (ancestor_id, descendant_id, depth) VALUES (uid, uid, 0);
              SELECT id INTO code_id FROM referral_codes WHERE user_id = parent AND program_id IS NULL AND is_active LIMIT 1;
              INSERT INTO referral_relationships (id, child_user_id, sponsor_user_id, referral_code_id, source, attributed_at, updated_at)
                VALUES (gen_random_uuid(), uid, parent, code_id, 'REGISTRATION', now(), now());
              INSERT INTO referral_paths (ancestor_id, descendant_id, depth)
                SELECT ancestor_id, uid, depth + 1 FROM referral_paths WHERE descendant_id = parent AND ancestor_id <> uid;
              INSERT INTO referral_codes (id, user_id, code, is_active, created_at)
                VALUES (gen_random_uuid(), uid, upper(substr(md5(uid::text), 1, 10)), true, now());
              ids := ids || uid;
            END LOOP;
          END $$;`);
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    await t.prisma.$executeRawUnsafe('ANALYZE referral_paths');
    const started = Date.now();
    const res = await su.post(`/api/v1/admin/members/${b.id}/sponsor-correction`).send({ newSponsorId: d.id, reason: 'move the whole team over' });
    const elapsed = Date.now() - started;
    expect(res.status).toBe(201);
    expect(res.body.data.affectedMembers).toBe(1002); // b, c and the 1 000 below c
    expect(elapsed).toBeLessThan(10_000);
    // Every member of the moved subtree: closure = sponsor's closure + 1 (raises otherwise).
    const checked = await t.prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(app_referral_assert_consistent(p."descendant_id"))::int AS "n" FROM "referral_paths" p WHERE p."ancestor_id" = ${b.id}::uuid`;
    expect(checked[0]!.n).toBe(1002);
    expect(await t.prisma.referralPath.count({ where: { ancestorId: a.id, depth: { gt: 0 } } })).toBe(0);
    expect(await t.prisma.referralPath.count({ where: { ancestorId: d.id, depth: { gt: 0 } } })).toBe(1002);
  }, 120_000);
});
