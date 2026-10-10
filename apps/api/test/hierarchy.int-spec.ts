import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { lockReferralTreeShared } from '../src/common/prisma/referral-tree-lock';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import {
  createEnrollment,
  createEvent,
  createProgram,
  createUser,
  factoryAdmin,
  loginAs,
  type TestUser,
} from './utils/factories';

const NODE_KEYS = [
  'childCount',
  'children',
  'childrenCursor',
  'childrenLoaded',
  'depth',
  'displayName',
  'hasEligibleEnrollment',
  'hasMoreChildren',
  'id',
  'joinedAt',
  'statusBucket',
].sort();

interface TreeNode {
  id: string;
  displayName: string;
  depth: number;
  childCount: number;
  children: TreeNode[];
  childrenLoaded: boolean;
  hasMoreChildren: boolean;
  childrenCursor: string | null;
  fullName?: string | null;
  inScope?: boolean;
}

function flatten(node: TreeNode): TreeNode[] {
  return [node, ...node.children.flatMap(flatten)];
}

/**
 * Bulk-creates members under existing sponsors in ONE registration-protocol transaction (users →
 * shared tree lock → self rows → codes → relationships + ancestor rows level by level → roles).
 * `edges` must list parents before children.
 */
async function bulkTree(
  prisma: PrismaClient,
  edges: ReadonlyArray<{ id: string; parentId: string; fullName: string }>,
): Promise<void> {
  const tag = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
  await prisma.$transaction(
    async (tx) => {
      const ids = edges.map((e) => e.id);
      await tx.user.createMany({
        data: edges.map((e, i) => ({
          id: e.id,
          email: `bulk-${tag.toLowerCase()}-${i}@example.test`,
          fullName: e.fullName,
          status: 'ACTIVE',
          emailVerifiedAt: new Date(),
        })),
      });
      await lockReferralTreeShared(tx);
      await tx.referralPath.createMany({ data: ids.map((id) => ({ ancestorId: id, descendantId: id, depth: 0 })) });
      await tx.referralCode.createMany({
        data: edges.map((e, i) => ({ userId: e.id, code: `Q${tag}${i.toString(36).toUpperCase().padStart(4, '0')}` })),
      });
      const parents = [...new Set(edges.map((e) => e.parentId))];
      const codes = await tx.referralCode.findMany({ where: { userId: { in: parents }, isActive: true } });
      const codeOf = new Map(codes.map((c) => [c.userId, c.id]));
      // Level by level: a child's rows are derived from its sponsor's (already complete) rows.
      const pending = new Set(ids);
      let remaining = [...edges];
      while (remaining.length > 0) {
        const level = remaining.filter((e) => !pending.has(e.parentId));
        remaining = remaining.filter((e) => pending.has(e.parentId));
        await tx.referralRelationship.createMany({
          data: level.map((e) => ({
            childUserId: e.id,
            sponsorUserId: e.parentId,
            referralCodeId: codeOf.get(e.parentId) as string,
            source: 'REGISTRATION' as const,
          })),
        });
        const levelIds = level.map((e) => e.id);
        await tx.$executeRaw`
          INSERT INTO "referral_paths" ("ancestor_id", "descendant_id", "depth")
          SELECT p."ancestor_id", r."child_user_id", p."depth" + 1
          FROM "referral_relationships" r
          JOIN "referral_paths" p ON p."descendant_id" = r."sponsor_user_id"
          WHERE r."child_user_id" = ANY(${levelIds}::uuid[])`;
        for (const id of levelIds) pending.delete(id);
        if (level.length === 0) throw new Error('bulkTree: parents must exist or precede children');
      }
      const member = await tx.role.findUniqueOrThrow({ where: { key: 'MEMBER' } });
      await tx.userRole.createMany({ data: ids.map((id) => ({ userId: id, roleId: member.id })) });
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
}

describe('team hierarchy (member + admin views) and sponsor corrections', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  beforeEach(async () => {
    await resetDatabase();
    await factoryAdmin(t.prisma);
  });
  afterAll(async () => {
    await t.close();
    await disconnectTestPrisma();
  });

  /**
   *            top
   *             │
   *            me ─────────┐
   *           ╱   ╲        │
   *       anita   bala   (sibling under top: "outsider")
   *         │
   *       chitra
   */
  async function smallTree() {
    const top = await createUser(t.prisma, { fullName: 'Top Upline' });
    const me = await createUser(t.prisma, { fullName: 'Meera Joshi', sponsor: top });
    const outsider = await createUser(t.prisma, { fullName: 'Outsider Person', sponsor: top });
    const anita = await createUser(t.prisma, { fullName: 'Anita Kumari Sharma', sponsor: me });
    const bala = await createUser(t.prisma, { fullName: 'Bala Krishnan', sponsor: me });
    const chitra = await createUser(t.prisma, { fullName: 'Chitra Iyer', sponsor: anita });
    return { top, me, outsider, anita, bala, chitra };
  }

  async function chain(length: number, from: TestUser): Promise<TestUser[]> {
    const users: TestUser[] = [];
    let sponsor = from;
    for (let i = 0; i < length; i += 1) {
      sponsor = await createUser(t.prisma, { fullName: `Level${i + 1} Member`, sponsor });
      users.push(sponsor);
    }
    return users;
  }

  describe('member views', () => {
    it('summary counts the team by depth with status buckets and eligibility', async () => {
      const { me, anita, bala } = await smallTree();
      await t.prisma.user.update({
        where: { id: bala.id },
        data: { status: 'SUSPENDED', suspendedAt: new Date(), suspensionReason: 'test' },
      });
      const program = await createProgram(t.prisma);
      await createEnrollment(t.prisma, { userId: anita.id, programId: program.id });

      const res = await (await loginAs(t, me)).get('/api/v1/users/me/hierarchy/summary').expect(200);
      expect(res.body.data).toEqual({
        directCount: 2,
        teamSize: 3,
        countsByDepth: [
          { depth: 1, count: 2 },
          { depth: 2, count: 1 },
        ],
        activeCount: 2,
        inactiveCount: 1,
        withEligibleEnrollmentCount: 1,
        maxDepth: 10,
      });
    });

    it('returns a privacy-filtered tree rooted at the viewer', async () => {
      const { me, anita, bala, chitra, top, outsider } = await smallTree();
      const res = await (await loginAs(t, me)).get('/api/v1/users/me/hierarchy/tree?depth=3').expect(200);
      const root: TreeNode = res.body.data.root;
      expect(res.body.data).toMatchObject({ maxDepth: 10, truncated: false });
      expect(root).toMatchObject({ id: me.id, depth: 0, childCount: 2, childrenLoaded: true });
      expect(root.children.map((c) => [c.id, c.displayName, c.depth])).toEqual([
        [anita.id, 'Anita S.', 1],
        [bala.id, 'Bala K.', 1],
      ]);
      expect(root.children[0]?.children.map((c) => [c.id, c.depth])).toEqual([[chitra.id, 2]]);
      for (const node of flatten(root)) expect(Object.keys(node).sort()).toEqual(NODE_KEYS);
      const json = JSON.stringify(res.body);
      for (const secret of [top.id, outsider.id, anita.email, 'Sharma', 'Krishnan', 'Iyer', 'Joshi']) {
        expect(json).not.toContain(secret);
      }
    });

    it('loads one level at a time and marks unloaded branches', async () => {
      const { me, anita } = await smallTree();
      const client = await loginAs(t, me);
      const res = await client.get('/api/v1/users/me/hierarchy/tree?depth=1').expect(200);
      const anitaNode = (res.body.data.root as TreeNode).children.find((c) => c.id === anita.id);
      expect(anitaNode).toMatchObject({ childCount: 1, childrenLoaded: false, children: [] });
      const sub = await client.get(`/api/v1/users/me/hierarchy/tree?rootId=${anita.id}&depth=1`).expect(200);
      expect(sub.body.data.root).toMatchObject({ id: anita.id, depth: 1, childrenLoaded: true });
      expect(sub.body.data.root.children[0].depth).toBe(2);
    });

    it("never exposes someone else's subtree (404, not 403)", async () => {
      const { me, top, outsider } = await smallTree();
      const client = await loginAs(t, me);
      for (const id of [top.id, outsider.id, randomUUID()]) {
        const tree = await client.get(`/api/v1/users/me/hierarchy/tree?rootId=${id}`).expect(404);
        expect(tree.body.error.code).toBe('NOT_FOUND');
        await client.get(`/api/v1/users/me/hierarchy/children?parentId=${id}`).expect(404);
        await client.get(`/api/v1/users/me/hierarchy/path/${id}`).expect(404);
      }
      await client.get('/api/v1/users/me/hierarchy/tree?rootId=not-a-uuid').expect(400);
      await client.get('/api/v1/users/me/hierarchy/tree?depth=4').expect(400);
    });

    it('builds the breadcrumb path from the viewer down', async () => {
      const { me, anita, chitra } = await smallTree();
      const res = await (await loginAs(t, me)).get(`/api/v1/users/me/hierarchy/path/${chitra.id}`).expect(200);
      expect(res.body.data.nodes).toEqual([
        { id: me.id, displayName: 'Meera J.', depth: 0 },
        { id: anita.id, displayName: 'Anita S.', depth: 1 },
        { id: chitra.id, displayName: 'Chitra I.', depth: 2 },
      ]);
    });

    it('searches display names of descendants only', async () => {
      const { me, anita, outsider } = await smallTree();
      const client = await loginAs(t, me);
      const found = await client.get('/api/v1/users/me/hierarchy/search?q=anita%20s').expect(200);
      expect(found.body.data).toEqual([{ id: anita.id, displayName: 'Anita S.', depth: 1, statusBucket: 'ACTIVE' }]);
      // Hidden name parts never match; non-descendants never match.
      for (const q of ['Sharma', 'Kumari', 'Outsider', 'Top', 'Meera']) {
        const res = await client.get(`/api/v1/users/me/hierarchy/search?q=${q}`).expect(200);
        expect(res.body.data).toEqual([]);
      }
      expect(JSON.stringify(found.body)).not.toContain(outsider.id);
      await client.get('/api/v1/users/me/hierarchy/search?q=a').expect(400);
      await client.get(`/api/v1/users/me/hierarchy/search?q=${encodeURIComponent('%_')}`).expect(200);
    });

    it('enforces the 10-level depth limit everywhere', async () => {
      const me = await createUser(t.prisma, { fullName: 'Deep Root' });
      const levels = await chain(12, me); // depths 1..12
      const d9 = levels[8] as TestUser;
      const d10 = levels[9] as TestUser;
      const d11 = levels[10] as TestUser;
      const client = await loginAs(t, me);

      const tree = await client.get(`/api/v1/users/me/hierarchy/tree?rootId=${d9.id}&depth=3`).expect(200);
      const nodes = flatten(tree.body.data.root);
      expect(nodes.map((n) => n.depth)).toEqual([9, 10]);
      expect(nodes[1]).toMatchObject({ id: d10.id, childCount: 0, childrenLoaded: true, children: [] });

      await client.get(`/api/v1/users/me/hierarchy/tree?rootId=${d11.id}`).expect(404);
      await client.get(`/api/v1/users/me/hierarchy/path/${d11.id}`).expect(404);
      const kids = await client.get(`/api/v1/users/me/hierarchy/children?parentId=${d10.id}`).expect(200);
      expect(kids.body.data).toEqual([]);
      const search = await client.get('/api/v1/users/me/hierarchy/search?q=Level').expect(200);
      expect(search.body.data.map((r: { depth: number }) => r.depth)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const summary = await client.get('/api/v1/users/me/hierarchy/summary').expect(200);
      expect(summary.body.data.teamSize).toBe(10);
      const referrals = await client.get(`/api/v1/users/me/hierarchy/path/${d10.id}`).expect(200);
      expect(referrals.body.data.nodes).toHaveLength(11);
    });

    it('caps children at 50 per node and pages the rest with a cursor', async () => {
      const me = await createUser(t.prisma, { fullName: 'Wide Root' });
      const kids = Array.from({ length: 63 }, (_, i) => ({ id: randomUUID(), parentId: me.id, fullName: `Kid${i} Wide` }));
      await bulkTree(t.prisma, kids);
      const client = await loginAs(t, me);
      const tree = await client.get('/api/v1/users/me/hierarchy/tree?depth=1').expect(200);
      const root: TreeNode = tree.body.data.root;
      expect(root.childCount).toBe(63);
      expect(root.children).toHaveLength(50);
      expect(root.hasMoreChildren).toBe(true);
      const page = await client
        .get(`/api/v1/users/me/hierarchy/children?parentId=${me.id}&cursor=${root.childrenCursor}`)
        .expect(200);
      expect(page.body.data).toHaveLength(13);
      expect(page.body.page.nextCursor).toBeNull();
      const all = new Set([...root.children.map((c) => c.id), ...page.body.data.map((c: { id: string }) => c.id)]);
      expect(all.size).toBe(63);
    });
  });

  describe('performance sanity (~2000 members)', () => {
    it('answers summary, tree, children, path and search from the closure table quickly', async () => {
      const me = await createUser(t.prisma, { fullName: 'Perf Root' });
      const edges: Array<{ id: string; parentId: string; fullName: string }> = [];
      const ternary: string[] = [me.id];
      for (let i = 1; i <= 1800; i += 1) {
        const id = randomUUID();
        edges.push({ id, parentId: ternary[Math.floor((i - 1) / 3)] as string, fullName: `Member${i} Perf` });
        ternary.push(id);
      }
      const wide = randomUUID();
      edges.push({ id: wide, parentId: me.id, fullName: 'Wide Hub' });
      for (let i = 0; i < 120; i += 1) edges.push({ id: randomUUID(), parentId: wide, fullName: `Leaf${i} Hub` });
      let prev = me.id;
      for (let i = 0; i < 14; i += 1) {
        const id = randomUUID();
        edges.push({ id, parentId: prev, fullName: `Chain${i} Deep` });
        prev = id;
      }
      await bulkTree(t.prisma, edges); // 1935 members, depth up to 14
      const client = await loginAs(t, me);

      const timed = async (url: string) => {
        const start = performance.now();
        const res = await client.get(url).expect(200);
        return { res, ms: performance.now() - start };
      };

      const summary = await timed('/api/v1/users/me/hierarchy/summary');
      expect(summary.res.body.data.teamSize).toBe(1800 + 1 + 120 + 10); // chain beyond depth 10 hidden
      expect(summary.res.body.data.directCount).toBe(3 + 1 + 1);
      expect(summary.ms).toBeLessThan(2000);

      const tree = await timed('/api/v1/users/me/hierarchy/tree?depth=3');
      const nodes = flatten(tree.res.body.data.root);
      expect(nodes.length).toBeLessThanOrEqual(600);
      expect(tree.ms).toBeLessThan(2000);

      const children = await timed(`/api/v1/users/me/hierarchy/children?parentId=${wide}&limit=50`);
      expect(children.res.body.data).toHaveLength(50);
      expect(children.ms).toBeLessThan(1000);

      const deepest = edges[1799] as { id: string };
      const path = await timed(`/api/v1/users/me/hierarchy/path/${deepest.id}`);
      expect(path.res.body.data.nodes[0].id).toBe(me.id);
      expect(path.ms).toBeLessThan(1000);

      const search = await timed('/api/v1/users/me/hierarchy/search?q=Member17&limit=50');
      expect(search.res.body.data.length).toBeGreaterThan(0);
      expect(search.ms).toBeLessThan(1500);
    });
  });

  describe('admin views', () => {
    it('shows full names to a SUPER_ADMIN without the member depth limit', async () => {
      const admin = await createUser(t.prisma, { roles: ['SUPER_ADMIN'] });
      const root = await createUser(t.prisma, { fullName: 'Root Member' });
      const levels = await chain(11, root);
      const client = await loginAs(t, admin);

      const tree = await client.get(`/api/v1/admin/members/${root.id}/hierarchy?depth=2`).expect(200);
      expect(tree.body.data.root).toMatchObject({ id: root.id, fullName: 'Root Member', inScope: true, status: 'ACTIVE' });
      const deep = levels[10] as TestUser;
      const path = await client.get(`/api/v1/admin/members/${root.id}/hierarchy/path/${deep.id}`).expect(200);
      expect(path.body.data.nodes).toHaveLength(12);
      expect(path.body.data.nodes[11]).toMatchObject({ id: deep.id, fullName: 'Level11 Member', depth: 11 });

      const anc = await client.get(`/api/v1/admin/members/${deep.id}/ancestors`).expect(200);
      expect(anc.body.data.ancestors).toHaveLength(11);
      expect(anc.body.data.ancestors[0]).toMatchObject({ depth: 1, fullName: 'Level10 Member' });
      expect(anc.body.data.attributionSource).toBe('REGISTRATION');

      const search = await client.get(`/api/v1/admin/members/${root.id}/hierarchy/search?q=Level11`).expect(200);
      expect(search.body.data).toEqual([
        expect.objectContaining({ id: deep.id, fullName: 'Level11 Member', depth: 11 }),
      ]);
      const summary = await client.get(`/api/v1/admin/members/${root.id}/hierarchy/summary`).expect(200);
      expect(summary.body.data).toMatchObject({ teamSize: 11, maxDepth: null });
      await client.get(`/api/v1/admin/members/${randomUUID()}/hierarchy`).expect(404);
    });

    it('limits a PROGRAM_ADMIN to members enrolled in their programs', async () => {
      const program = await createProgram(t.prisma);
      const other = await createProgram(t.prisma);
      const pa = await createUser(t.prisma, { roles: ['PROGRAM_ADMIN'], programScopes: [program.id] });
      const root = await createUser(t.prisma, { fullName: 'Scoped Root' });
      const enrolledKid = await createUser(t.prisma, { fullName: 'Enrolled Kid', sponsor: root });
      const otherKid = await createUser(t.prisma, { fullName: 'Hidden Kidname', sponsor: root });
      const stranger = await createUser(t.prisma, { fullName: 'Not Enrolled' });
      await createEnrollment(t.prisma, { userId: root.id, programId: program.id });
      await createEnrollment(t.prisma, { userId: enrolledKid.id, programId: program.id });
      await createEnrollment(t.prisma, { userId: otherKid.id, programId: other.id });
      const client = await loginAs(t, pa);

      const res = await client.get(`/api/v1/admin/members/${root.id}/hierarchy`).expect(200);
      const kids: TreeNode[] = res.body.data.root.children;
      expect(kids.find((k) => k.id === enrolledKid.id)).toMatchObject({ fullName: 'Enrolled Kid', inScope: true });
      expect(kids.find((k) => k.id === otherKid.id)).toMatchObject({ fullName: null, inScope: false, displayName: 'Hidden K.' });
      expect(JSON.stringify(res.body)).not.toContain('Kidname');

      const search = await client.get(`/api/v1/admin/members/${root.id}/hierarchy/search?q=Kid`).expect(200);
      expect(search.body.data.map((r: { id: string }) => r.id)).toEqual([enrolledKid.id]);

      // Outside the scope a member behaves as missing (no existence oracle).
      const denied = await client.get(`/api/v1/admin/members/${stranger.id}/hierarchy`).expect(404);
      expect(denied.body.error.code).toBe('NOT_FOUND');
      await client.get(`/api/v1/admin/members/${otherKid.id}/ancestors`).expect(404);
      await client.get(`/api/v1/admin/members/${stranger.id}/hierarchy/summary`).expect(404);
    });

    it('rejects members and admins without members:read', async () => {
      const member = await createUser(t.prisma);
      const target = await createUser(t.prisma);
      await (await loginAs(t, member)).get(`/api/v1/admin/members/${target.id}/hierarchy`).expect(403);
      const unverified = await createUser(t.prisma, { roles: ['SUPER_ADMIN'] });
      const res = await (await loginAs(t, unverified, { mfa: 'EMAIL_OTP' }))
        .get(`/api/v1/admin/members/${target.id}/hierarchy`)
        .expect(403);
      expect(res.body.error.code).toBe('MFA_REQUIRED');
    });
  });

  describe('sponsor correction', () => {
    /** a ─ b ─ c ─ d  and  x ─ y ; corrector is an unrelated SUPER_ADMIN. */
    async function forest() {
      const corrector = await createUser(t.prisma, { fullName: 'Corrector Admin', roles: ['SUPER_ADMIN'] });
      const a = await createUser(t.prisma, { fullName: 'Alpha One' });
      const b = await createUser(t.prisma, { fullName: 'Beta Two', sponsor: a });
      const c = await createUser(t.prisma, { fullName: 'Gamma Three', sponsor: b });
      const d = await createUser(t.prisma, { fullName: 'Delta Four', sponsor: c });
      const x = await createUser(t.prisma, { fullName: 'Xavier Five' });
      const y = await createUser(t.prisma, { fullName: 'Yamini Six', sponsor: x });
      return { corrector, a, b, c, d, x, y };
    }

    async function pathsOf(userId: string) {
      const rows = await t.prisma.referralPath.findMany({ where: { descendantId: userId }, orderBy: { depth: 'asc' } });
      return rows.map((r) => [r.ancestorId, r.depth]);
    }

    it('previews the move with the affected subtree size', async () => {
      const { corrector, b, c, y } = await forest();
      const client = await loginAs(t, corrector);
      const res = await client.get(`/api/v1/admin/members/${c.id}/sponsor-correction/preview?newSponsorId=${y.id}`).expect(200);
      expect(res.body.data).toMatchObject({
        member: { id: c.id, fullName: 'Gamma Three' },
        currentSponsor: { id: b.id },
        newSponsor: { id: y.id },
        affectedMembers: 2,
        newDepthFromRoot: 2,
        receivedEventCount: 0,
        issues: [],
        canApply: true,
      });
      const cyc = await client.get(`/api/v1/admin/members/${b.id}/sponsor-correction/preview?newSponsorId=${c.id}`).expect(200);
      expect(cyc.body.data).toMatchObject({ canApply: false, issues: [expect.objectContaining({ code: 'CYCLE' })] });
    });

    it('moves the subtree following the protocol, with audit and correction record', async () => {
      const { corrector, a, b, c, d, x, y } = await forest();
      const client = await loginAs(t, corrector);
      const res = await client
        .post(`/api/v1/admin/members/${c.id}/sponsor-correction`)
        .send({ newSponsorId: y.id, reason: 'Registered with the wrong referral link' })
        .expect(201);
      expect(res.body.data).toMatchObject({
        memberId: c.id,
        previousSponsorId: b.id,
        newSponsorId: y.id,
        affectedMembers: 2,
      });

      expect(await pathsOf(c.id)).toEqual([
        [c.id, 0],
        [y.id, 1],
        [x.id, 2],
      ]);
      expect(await pathsOf(d.id)).toEqual([
        [d.id, 0],
        [c.id, 1],
        [y.id, 2],
        [x.id, 3],
      ]);
      expect(await t.prisma.referralPath.count({ where: { ancestorId: a.id } })).toBe(2); // a, b
      const rel = await t.prisma.referralRelationship.findUniqueOrThrow({ where: { childUserId: c.id } });
      expect(rel).toMatchObject({ sponsorUserId: y.id, source: 'ADMIN_CORRECTION', referralCodeId: null });
      const correction = await t.prisma.referralCorrection.findUniqueOrThrow({ where: { id: res.body.data.correctionId } });
      expect(correction).toMatchObject({ childUserId: c.id, previousSponsorId: b.id, newSponsorId: y.id, performedById: corrector.id });
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'referral.correct', resourceId: c.id } });
      expect(audit).toMatchObject({ actorUserId: corrector.id, reason: 'Registered with the wrong referral link' });
      expect(audit.before).toEqual({ sponsorUserId: b.id });

      // The moved member sees the new upline.
      const parent = await (await loginAs(t, c)).get('/api/v1/users/me/parent').expect(200);
      expect(parent.body.data.sponsor).toMatchObject({ displayName: 'Yamini S.', attributionSource: 'ADMIN_CORRECTION' });
    });

    it('attaches a former root member (with its team) under a sponsor', async () => {
      const { corrector, a, b, c, d, x, y } = await forest();
      const client = await loginAs(t, corrector);
      await client
        .post(`/api/v1/admin/members/${x.id}/sponsor-correction`)
        .send({ newSponsorId: d.id, reason: 'Merged duplicate network after support review' })
        .expect(201);
      expect(await pathsOf(y.id)).toEqual([
        [y.id, 0],
        [x.id, 1],
        [d.id, 2],
        [c.id, 3],
        [b.id, 4],
        [a.id, 5],
      ]);
      const rel = await t.prisma.referralRelationship.findUniqueOrThrow({ where: { childUserId: x.id } });
      expect(rel).toMatchObject({ sponsorUserId: d.id, source: 'ADMIN_CORRECTION' });
    });

    it('rejects cycles, no-ops and inactive sponsors', async () => {
      const { corrector, a, b, c, d, y } = await forest();
      const client = await loginAs(t, corrector);
      const reason = 'Support ticket 4711: wrong sponsor';
      const cycle = await client.post(`/api/v1/admin/members/${b.id}/sponsor-correction`).send({ newSponsorId: d.id, reason }).expect(409);
      expect(cycle.body.error.code).toBe('REFERRAL_CYCLE');
      const self = await client.post(`/api/v1/admin/members/${b.id}/sponsor-correction`).send({ newSponsorId: b.id, reason }).expect(409);
      expect(self.body.error.code).toBe('REFERRAL_CYCLE');
      const same = await client.post(`/api/v1/admin/members/${c.id}/sponsor-correction`).send({ newSponsorId: b.id, reason }).expect(409);
      expect(same.body.error.details.issues[0].code).toBe('SAME_SPONSOR');
      await t.prisma.user.update({ where: { id: y.id }, data: { status: 'SUSPENDED', suspendedAt: new Date(), suspensionReason: 'x' } });
      const inactive = await client.post(`/api/v1/admin/members/${c.id}/sponsor-correction`).send({ newSponsorId: y.id, reason }).expect(409);
      expect(inactive.body.error.details.issues[0].code).toBe('SPONSOR_INACTIVE');
      expect(await t.prisma.referralCorrection.count()).toBe(0);
      expect(await pathsOf(b.id)).toEqual([
        [b.id, 0],
        [a.id, 1],
      ]);
    });

    it('enforces segregation of duties (performer upline of the new sponsor, or a party)', async () => {
      const { c, d } = await forest();
      const insider = await createUser(t.prisma, { fullName: 'Insider Admin', roles: ['SUPER_ADMIN'] });
      const insiderKid = await createUser(t.prisma, { sponsor: insider });
      const client = await loginAs(t, insider);
      const reason = 'Move to my own team please';
      const res = await client.post(`/api/v1/admin/members/${c.id}/sponsor-correction`).send({ newSponsorId: insiderKid.id, reason }).expect(403);
      expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', details: { reason: 'SEGREGATION_OF_DUTIES' } });
      await client.post(`/api/v1/admin/members/${c.id}/sponsor-correction`).send({ newSponsorId: insider.id, reason }).expect(403);
      // The moved member cannot correct themselves even as an admin.
      const selfAdmin = await createUser(t.prisma, { roles: ['SUPER_ADMIN'] });
      const selfMoved = await createUser(t.prisma, { sponsor: selfAdmin, roles: ['SUPER_ADMIN'] });
      const own = await loginAs(t, selfMoved);
      await own.post(`/api/v1/admin/members/${selfMoved.id}/sponsor-correction`).send({ newSponsorId: d.id, reason }).expect(403);
      expect(await t.prisma.referralCorrection.count()).toBe(0);
    });

    it('is blocked while the moved subtree has unprocessed (RECEIVED) sales', async () => {
      const { corrector, c, d, y } = await forest();
      const program = await createProgram(t.prisma);
      await createEvent(t.prisma, { programId: program.id, subjectUserId: d.id });
      const client = await loginAs(t, corrector);
      const preview = await client.get(`/api/v1/admin/members/${c.id}/sponsor-correction/preview?newSponsorId=${y.id}`).expect(200);
      expect(preview.body.data).toMatchObject({ receivedEventCount: 1, canApply: false });
      const res = await client
        .post(`/api/v1/admin/members/${c.id}/sponsor-correction`)
        .send({ newSponsorId: y.id, reason: 'Wrong link used during sign-up' })
        .expect(409);
      expect(res.body.error).toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
      expect(res.body.error.details.issues[0].code).toBe('RECEIVED_EVENTS');
    });

    it('requires referrals:correct and a valid reason', async () => {
      const { c, y } = await forest();
      const program = await createProgram(t.prisma);
      const pa = await createUser(t.prisma, { roles: ['PROGRAM_ADMIN'], programScopes: [program.id] });
      const fin = await createUser(t.prisma, { roles: ['FINANCE_REVIEWER'] });
      const body = { newSponsorId: y.id, reason: 'Long enough reason here' };
      for (const user of [pa, fin]) {
        const res = await (await loginAs(t, user)).post(`/api/v1/admin/members/${c.id}/sponsor-correction`).send(body).expect(403);
        expect(res.body.error.details.missingPermissions).toEqual(['referrals:correct']);
      }
      const admin = await createUser(t.prisma, { roles: ['SUPER_ADMIN'] });
      const client = await loginAs(t, admin);
      await client.post(`/api/v1/admin/members/${c.id}/sponsor-correction`).send({ newSponsorId: y.id, reason: 'short' }).expect(400);
      await client
        .post(`/api/v1/admin/members/${randomUUID()}/sponsor-correction`)
        .send(body)
        .expect(404);
    });
  });
});
