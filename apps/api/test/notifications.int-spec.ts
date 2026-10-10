import type { ApiPage, NotificationDto } from '@app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import { createUser, loginAs, type LoggedInClient, type TestUser } from './utils/factories';

describe('/users/me/notifications', () => {
  let t: TestApp;
  let anita: TestUser;
  let rahul: TestUser;
  let client: LoggedInClient;
  let ids: string[];

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
    await disconnectTestPrisma();
  });

  beforeEach(async () => {
    await resetDatabase();
    anita = await createUser(t.prisma);
    rahul = await createUser(t.prisma);
    ids = [];
    for (let i = 0; i < 5; i++) {
      const n = await t.prisma.notification.create({
        data: {
          userId: anita.id,
          type: i === 4 ? 'announcement.maintenance' : 'reward.status',
          title: `Title ${i}`,
          body: `Body ${i}`,
          data: { index: i },
          createdAt: new Date(Date.now() - (5 - i) * 60_000),
          readAt: i === 0 ? new Date() : null,
        },
      });
      ids.push(n.id);
    }
    await t.prisma.notification.create({ data: { userId: rahul.id, type: 'reward.status', title: 'Rahul only', body: 'x' } });
    client = await loginAs(t, anita);
  });

  const listPage = async (query = '') =>
    (await client.get(`/api/v1/users/me/notifications${query}`).expect(200)).body as ApiPage<NotificationDto>;

  it('lists only my notifications, newest first, with an unread filter and cursor', async () => {
    const all = await listPage();
    expect(all.data.map((n) => n.id)).toEqual([...ids].reverse());
    expect(all.data[0]).toEqual({
      id: ids[4],
      type: 'announcement.maintenance',
      title: 'Title 4',
      body: 'Body 4',
      data: { index: 4 },
      readAt: null,
      createdAt: expect.any(String),
    });
    expect(JSON.stringify(all)).not.toContain('Rahul only');

    const unread = await listPage('?unread=true');
    expect(unread.data.map((n) => n.id)).toEqual(ids.slice(1).reverse());
    expect((await listPage('?unread=false')).data.map((n) => n.id)).toEqual([ids[0]]);

    const first = await listPage('?limit=2');
    expect(first.data.map((n) => n.id)).toEqual([ids[4], ids[3]]);
    const second = await listPage(`?limit=2&cursor=${first.page.nextCursor}`);
    expect(second.data.map((n) => n.id)).toEqual([ids[2], ids[1]]);
    await client.get('/api/v1/users/me/notifications?unread=maybe').expect(400);
  });

  it('counts unread, marks one read (idempotent) and all read', async () => {
    expect((await client.get('/api/v1/users/me/notifications/unread-count').expect(200)).body.data).toEqual({ count: 4 });

    const read = await client.post(`/api/v1/users/me/notifications/${ids[2]}/read`).expect(200);
    expect(read.body.data).toMatchObject({ id: ids[2], readAt: expect.any(String) });
    const again = await client.post(`/api/v1/users/me/notifications/${ids[2]}/read`).expect(200);
    expect(again.body.data.readAt).toBe(read.body.data.readAt);
    expect((await client.get('/api/v1/users/me/notifications/unread-count').expect(200)).body.data).toEqual({ count: 3 });

    const all = await client.post('/api/v1/users/me/notifications/read-all').expect(200);
    expect(all.body.data).toEqual({ updated: 3 });
    expect((await client.get('/api/v1/users/me/notifications/unread-count').expect(200)).body.data).toEqual({ count: 0 });
    // Rahul's notification is untouched.
    expect(await t.prisma.notification.count({ where: { userId: rahul.id, readAt: null } })).toBe(1);
  });

  it("returns 404 for someone else's notification and never modifies it", async () => {
    const other = await t.prisma.notification.findFirstOrThrow({ where: { userId: rahul.id } });
    const res = await client.post(`/api/v1/users/me/notifications/${other.id}/read`).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect((await t.prisma.notification.findUniqueOrThrow({ where: { id: other.id } })).readAt).toBeNull();
    await client.post('/api/v1/users/me/notifications/not-a-uuid/read').expect(400);
  });

  it('requires a session and CSRF for mutations', async () => {
    await t.client().get('/api/v1/users/me/notifications').expect(401);
    await t.client().get('/api/v1/users/me/notifications/unread-count').expect(401);
    const res = await client.withoutCsrf().post('/api/v1/users/me/notifications/read-all').expect(403);
    expect(res.body.error.code).toBe('CSRF_FAILED');
  });

  it('notify() → outbox → notification row that the list then shows', async () => {
    const service = t.get(NotificationsService);
    const { outboxId } = await t.prisma.$transaction((tx) =>
      service.notify(tx, { userId: anita.id, type: 'account.test', title: 'Queued', body: 'Via outbox', dedupeKey: 'test-queued' }),
    );
    const message = await t.prisma.outboxMessage.findUniqueOrThrow({ where: { id: outboxId } });
    expect(message.topic).toBe('notification.create');
    // Simulate the worker's notification handler (idempotent insert keyed by the outbox id).
    const payload = message.payload as { userId: string; type: string; title: string; body: string };
    await t.prisma.notification.create({ data: { ...payload, sourceKey: outboxId } });
    expect((await listPage('?limit=1')).data[0]).toMatchObject({ type: 'account.test', title: 'Queued' });
  });
});
