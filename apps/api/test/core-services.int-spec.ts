import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../src/common/audit/audit.service';
import type { AuthContext } from '../src/common/auth/auth-context';
import { RequestContext } from '../src/common/context/request-context';
import { OutboxService } from '../src/common/outbox/outbox.service';
import { PlatformSettingsService, toAmountFormat } from '../src/common/settings/platform-settings.service';
import { OutboxRelay } from '../src/jobs/outbox/outbox-relay.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import { createUser } from './utils/factories';

const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';

describe('core services (outbox relay, notifications, email, audit, settings)', () => {
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

  it('NotificationsService.notify enqueues in-tx; the relay inserts the notification idempotently', async () => {
    const user = await createUser(t.prisma);
    const notifications = t.get(NotificationsService);
    const { outboxId, enqueued } = await t.prisma.runInTransaction((tx) =>
      notifications.notify(tx, { userId: user.id, type: 'test.hello', title: 'Hello', body: 'World', data: { n: 1n }, dedupeKey: 'hello-1' }),
    );
    expect(enqueued).toBe(true);
    // same dedupe key → no second message, and the surrounding transaction still commits
    const again = await t.prisma.runInTransaction(async (tx) => {
      const r = await notifications.notify(tx, { userId: user.id, type: 'test.hello', title: 'Hello', body: 'World', dedupeKey: 'hello-1' });
      await tx.auditLog.create({ data: { action: 'after.dedupe', resourceType: 'test', actorRoles: [] } });
      return r;
    });
    expect(again.enqueued).toBe(false);
    expect(await t.prisma.auditLog.count({ where: { action: 'after.dedupe' } })).toBe(1);

    const result = await t.get(OutboxRelay).drain();
    expect(result).toMatchObject({ claimed: 1, sent: 1, failed: 0, dead: 0 });
    const n = await t.prisma.notification.findUniqueOrThrow({ where: { id: outboxId } });
    expect(n).toMatchObject({ userId: user.id, type: 'test.hello', title: 'Hello', body: 'World', data: { n: '1' } });
    const msg = await t.prisma.outboxMessage.findUniqueOrThrow({ where: { id: outboxId } });
    expect(msg.status).toBe('SENT');
    expect(msg.attempts).toBe(1);
  });

  it('delivers OTP email via SMTP and scrubs the code from the outbox row', async () => {
    const to = `otp-${Date.now()}@example.test`;
    const code = String(100000 + Math.floor(Math.random() * 899999));
    const { id } = await t.get(OutboxService).enqueue(t.prisma, {
      topic: 'email.send',
      payload: { to, template: 'otp', data: { code, purpose: 'LOGIN_MFA', expiresInMinutes: 10, name: 'Ada' } },
    });
    const r = await t.get(OutboxRelay).runOnce();
    expect(r.sent).toBe(1);
    const msg = await t.prisma.outboxMessage.findUniqueOrThrow({ where: { id } });
    expect(msg.status).toBe('SENT');
    expect(JSON.stringify(msg.payload)).not.toContain(code);
    expect((msg.payload as { data: { code: string } }).data.code).toBe('[redacted]');

    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
    expect(res.ok).toBe(true);
    const found = (await res.json()) as { messages: Array<{ ID: string; Subject: string }> };
    expect(found.messages).toHaveLength(1);
    expect(found.messages[0]!.Subject).toContain('sign-in verification code');
    const full = (await (await fetch(`${MAILPIT}/api/v1/message/${found.messages[0]!.ID}`)).json()) as { Text: string };
    expect(full.Text).toContain(code);
  });

  it('retries failures with backoff and marks messages DEAD after maxAttempts', async () => {
    const outbox = t.get(OutboxService);
    const { id } = await outbox.enqueue(t.prisma, {
      topic: 'notification.create',
      payload: { userId: '00000000-0000-4000-8000-000000000000', type: 't', title: 'x', body: 'y' },
    });
    // unknown user → PermanentOutboxError → DEAD immediately
    expect((await t.get(OutboxRelay).runOnce()).dead).toBe(1);
    expect((await t.prisma.outboxMessage.findUniqueOrThrow({ where: { id } })).status).toBe('DEAD');

    // unregistered topic → FAILED with a future availableAt, then DEAD at the last attempt
    const unknown = await t.prisma.outboxMessage.create({ data: { topic: 'nope.topic', payload: {}, maxAttempts: 2 } });
    const r1 = await t.get(OutboxRelay).runOnce();
    expect(r1.failed).toBe(1);
    const failed = await t.prisma.outboxMessage.findUniqueOrThrow({ where: { id: unknown.id } });
    expect(failed.status).toBe('FAILED');
    expect(failed.availableAt.getTime()).toBeGreaterThan(Date.now() + 1000);
    expect(failed.lastError).toContain('No outbox handler');
    expect((await t.get(OutboxRelay).runOnce()).claimed).toBe(0); // not due yet
    await t.prisma.outboxMessage.update({ where: { id: unknown.id }, data: { availableAt: new Date(Date.now() - 1000) } });
    expect((await t.get(OutboxRelay).runOnce()).dead).toBe(1);
    expect((await t.prisma.outboxMessage.findUniqueOrThrow({ where: { id: unknown.id } })).status).toBe('DEAD');
  });

  it('AuditService.record uses the request context and strips secrets', async () => {
    const user = await createUser(t.prisma, { roles: ['SUPER_ADMIN'] });
    const auth: AuthContext = {
      userId: user.id,
      sessionId: '00000000-0000-4000-8000-000000000001',
      email: user.email,
      fullName: user.fullName,
      roles: ['MEMBER', 'SUPER_ADMIN'],
      permissions: new Set(),
      programScopes: [],
      isAdmin: true,
      mfaVerified: true,
      sessionExpiresAt: new Date(Date.now() + 3_600_000),
    };
    const audit = t.get(AuditService);
    const { id } = await RequestContext.run({ requestId: 'req-audit-123', ip: '10.0.0.1', auth }, () =>
      t.prisma.runInTransaction((tx) =>
        audit.record(tx, {
          action: 'user.update',
          resourceType: 'user',
          resourceId: user.id,
          before: { email: 'a@b.c', passwordHash: 'h', nested: { token: 't', ok: 1 } },
          after: { amountMinor: 5n, items: [{ code: '123456', label: 'x' }] },
          reason: 'testing',
        }),
      ),
    );
    const row = await t.prisma.auditLog.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      actorUserId: user.id,
      actorRoles: ['MEMBER', 'SUPER_ADMIN'],
      requestId: 'req-audit-123',
      ipAddress: '10.0.0.1',
      before: { email: 'a@b.c', nested: { ok: 1 } },
      after: { amountMinor: '5', items: [{ label: 'x' }] },
    });

    const system = await audit.record(t.prisma, { action: 'job.run', resourceType: 'job', actorUserId: null });
    expect((await t.prisma.auditLog.findUniqueOrThrow({ where: { id: system.id } })).actorRoles).toEqual(['SYSTEM']);
  });

  it('PlatformSettingsService creates the singleton on demand and caches until invalidate()', async () => {
    await t.prisma.platformSettings.deleteMany();
    const svc = t.get(PlatformSettingsService);
    svc.invalidate();
    const s = await svc.get();
    expect(s).toMatchObject({ id: 1, rewardUnit: 'POINTS', currencyCode: 'INR', payoutsEnabled: false });
    expect(toAmountFormat(s)).toEqual({ unit: 'POINTS', currencyCode: 'INR', minorUnits: 0, pointsLabel: 'Points' });

    await t.prisma.platformSettings.update({ where: { id: 1 }, data: { rewardUnit: 'MONEY' } });
    expect((await svc.get()).rewardUnit).toBe('POINTS'); // cached
    expect((await svc.get(t.prisma)).rewardUnit).toBe('MONEY'); // explicit db bypasses the cache
    svc.invalidate();
    expect(toAmountFormat(await svc.get())).toEqual({ unit: 'MONEY', currencyCode: 'INR', minorUnits: 2, pointsLabel: 'Points' });
  });
});
