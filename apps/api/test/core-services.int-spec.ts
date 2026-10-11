import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../src/common/audit/audit.service';
import type { AuthContext } from '../src/common/auth/auth-context';
import { RequestContext } from '../src/common/context/request-context';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { mapDbError } from '../src/common/errors/db-error';
import { OtpMailer } from '../src/common/outbox/otp-mailer';
import { OutboxService } from '../src/common/outbox/outbox.service';
import {
  PlatformSettingsService,
  toAmountFormat,
  toRecordAmountFormat,
} from '../src/common/settings/platform-settings.service';
import { OtpEmailOutboxHandler } from '../src/jobs/email/otp-email.handler';
import { OutboxCleanupJob } from '../src/jobs/outbox/outbox-cleanup.job';
import { OutboxRelay } from '../src/jobs/outbox/outbox-relay.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { seedSuperAdmin } from '../prisma/seed-lib';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import { createProgram, createUser, type TestUser } from './utils/factories';

const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';

async function mailpitSearch(to: string): Promise<Array<{ ID: string; Subject: string }>> {
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
  expect(res.ok).toBe(true);
  return ((await res.json()) as { messages: Array<{ ID: string; Subject: string }> }).messages;
}

describe('core services (outbox relay, OTP delivery, notifications, audit, settings, seed)', () => {
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

  /** Opens a PASSWORD_RESET challenge for `user` with `code` and enqueues the OTP email (one tx). */
  async function issueOtp(user: TestUser, code: string, overrides: { createdAt?: Date; expiresAt?: Date } = {}) {
    const crypto = t.get(CryptoService);
    return t.prisma.runInTransaction(async (tx) => {
      const ch = await tx.emailChallenge.create({
        data: {
          userId: user.id,
          email: user.email,
          purpose: 'PASSWORD_RESET',
          codeHash: crypto.otpCodeHash('PASSWORD_RESET', user.email, code),
          ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
          expiresAt: overrides.expiresAt ?? new Date(Date.now() + 10 * 60_000),
        },
      });
      const { outboxId } = await t.get(OtpMailer).enqueue(tx, { challengeId: ch.id, code, email: user.email, purpose: 'PASSWORD_RESET' });
      return { challengeId: ch.id, outboxId };
    });
  }

  describe('notifications', () => {
    it('NotificationsService.notify enqueues in-tx; the relay inserts once with source_key = outbox id', async () => {
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
      const n = await t.prisma.notification.findUniqueOrThrow({ where: { sourceKey: outboxId } });
      expect(n).toMatchObject({ userId: user.id, type: 'test.hello', title: 'Hello', body: 'World', data: { n: '1' } });
      const msg = await t.prisma.outboxMessage.findUniqueOrThrow({ where: { id: outboxId } });
      expect(msg.status).toBe('SENT');
      expect(msg.attempts).toBe(1);

      // at-least-once redelivery (e.g. crash after insert, before SENT) creates no duplicate
      await t.prisma.outboxMessage.update({ where: { id: outboxId }, data: { status: 'PENDING', processedAt: null } });
      expect((await t.get(OutboxRelay).drain()).sent).toBe(1);
      expect(await t.prisma.notification.count({ where: { userId: user.id } })).toBe(1);
    });
  });

  describe('OTP emails (email.otp)', () => {
    it('stores only an AES-GCM ciphertext, delivers via SMTP and scrubs the ciphertext when SENT', async () => {
      const user = await createUser(t.prisma, { email: `otp-${Date.now()}@example.test`, fullName: 'Ada Lovelace' });
      const code = String(100000 + Math.floor(Math.random() * 899999));
      const { challengeId, outboxId } = await issueOtp(user, code);

      const pending = await t.prisma.outboxMessage.findUniqueOrThrow({ where: { id: outboxId } });
      expect(pending.topic).toBe('email.otp');
      expect(Object.keys(pending.payload as object).sort()).toEqual(['challengeId', 'codeCiphertext', 'template']);
      expect(pending.payload).toMatchObject({ challengeId, template: 'otp' });
      expect(JSON.stringify(pending.payload)).not.toContain(code);
      expect(JSON.stringify(pending.payload)).not.toContain(user.email);
      expect(pending.maxAttempts).toBe(6);

      expect((await t.get(OutboxRelay).runOnce()).sent).toBe(1);
      const sent = await t.prisma.outboxMessage.findUniqueOrThrow({ where: { id: outboxId } });
      expect(sent.status).toBe('SENT');
      expect(sent.payload).toEqual({ challengeId, template: 'otp' });

      const found = await mailpitSearch(user.email);
      expect(found).toHaveLength(1);
      expect(found[0]!.Subject).toContain('Reset your password');
      const full = (await (await fetch(`${MAILPIT}/api/v1/message/${found[0]!.ID}`)).json()) as { Text: string };
      expect(full.Text).toContain(code);
      expect(full.Text).toContain('Hi Ada Lovelace');
    });

    it('a verification code email never greets with the unverified registration name', async () => {
      const email = `pending-${Date.now()}@example.test`;
      const code = String(100000 + Math.floor(Math.random() * 899999));
      const crypto = t.get(CryptoService);
      await t.prisma.runInTransaction(async (tx) => {
        const ch = await tx.emailChallenge.create({
          data: {
            email,
            purpose: 'EMAIL_VERIFICATION',
            codeHash: crypto.otpCodeHash('EMAIL_VERIFICATION', email, code),
            expiresAt: new Date(Date.now() + 10 * 60_000),
            pendingFullName: 'Visit https://evil.example now',
            pendingPasswordHash: 'x',
          },
        });
        await t.get(OtpMailer).enqueue(tx, { challengeId: ch.id, code, email, purpose: 'EMAIL_VERIFICATION' });
      });
      expect((await t.get(OutboxRelay).runOnce()).sent).toBe(1);
      const found = await mailpitSearch(email);
      expect(found).toHaveLength(1);
      const full = (await (await fetch(`${MAILPIT}/api/v1/message/${found[0]!.ID}`)).json()) as { Text: string; HTML: string };
      expect(full.Text).toContain(code);
      expect(full.Text).not.toContain('evil.example');
      expect(full.HTML).not.toContain('evil.example');
      expect(full.Text.startsWith('Hi,')).toBe(true);
    });

    it('skips (SENT, scrubbed, no email) when the challenge is consumed, invalidated, expired or re-issued', async () => {
      const handler = t.get(OtpEmailOutboxHandler);
      const cases: Array<[string, (challengeId: string) => Promise<unknown>]> = [
        ['skipped:consumed', (id) => t.prisma.emailChallenge.update({ where: { id }, data: { consumedAt: new Date() } })],
        ['skipped:invalidated', (id) => t.prisma.emailChallenge.update({ where: { id }, data: { invalidatedAt: new Date() } })],
        [
          'skipped:stale',
          (id) =>
            t.prisma.emailChallenge.update({
              where: { id },
              data: { codeHash: t.get(CryptoService).otpCodeHash('PASSWORD_RESET', 'x@example.test', '999999') },
            }),
        ],
      ];
      for (const [expected, mutate] of cases) {
        const user = await createUser(t.prisma, { email: `skip-${expected.slice(8)}-${Date.now()}@example.test` });
        const { challengeId, outboxId } = await issueOtp(user, '123456');
        await mutate(challengeId);
        const row = await t.prisma.outboxMessage.findUniqueOrThrow({ where: { id: outboxId } });
        const view = { id: row.id, topic: row.topic, payload: row.payload as never, attempts: 1, maxAttempts: 6, createdAt: row.createdAt };
        expect(await handler.handle(view)).toBe(expected);
        expect((await t.get(OutboxRelay).runOnce()).sent).toBe(1);
        const done = await t.prisma.outboxMessage.findUniqueOrThrow({ where: { id: outboxId } });
        expect(done.status).toBe('SENT');
        expect(done.payload).toEqual({ challengeId, template: 'otp' });
        expect(await mailpitSearch(user.email)).toHaveLength(0);
      }

      const late = await createUser(t.prisma, { email: `skip-expired-${Date.now()}@example.test` });
      const expired = await issueOtp(late, '123456', { createdAt: new Date(Date.now() - 20 * 60_000), expiresAt: new Date(Date.now() - 60_000) });
      expect((await t.get(OutboxRelay).runOnce()).sent).toBe(1);
      expect((await t.prisma.outboxMessage.findUniqueOrThrow({ where: { id: expired.outboxId } })).payload).toEqual({
        challengeId: expired.challengeId,
        template: 'otp',
      });
      expect(await mailpitSearch(late.email)).toHaveLength(0);
    });

    it('a tampered ciphertext goes DEAD, scrubbed, with a last_error that does not contain the payload', async () => {
      const user = await createUser(t.prisma);
      const { challengeId, outboxId } = await issueOtp(user, '654321');
      const row = await t.prisma.outboxMessage.findUniqueOrThrow({ where: { id: outboxId } });
      const ct = (row.payload as { codeCiphertext: string }).codeCiphertext;
      const tampered = `${ct.slice(0, -2)}${ct.endsWith('AA') ? 'BB' : 'AA'}`;
      await t.prisma.outboxMessage.update({ where: { id: outboxId }, data: { payload: { challengeId, codeCiphertext: tampered, template: 'otp' } } });

      expect((await t.get(OutboxRelay).runOnce()).dead).toBe(1);
      const dead = await t.prisma.outboxMessage.findUniqueOrThrow({ where: { id: outboxId } });
      expect(dead.status).toBe('DEAD');
      expect(dead.payload).toEqual({ challengeId, template: 'otp' });
      expect(dead.lastError).toContain('could not be decrypted');
      expect(dead.lastError).not.toContain(tampered);
      expect(dead.lastError).not.toContain(challengeId);
    });

    it('DB + app guards: no plaintext code/otp keys in any payload, no ciphertext on SENT/DEAD rows', async () => {
      const outbox = t.get(OutboxService);
      await expect(
        outbox.enqueue(t.prisma, {
          topic: 'notification.create',
          payload: { userId: '00000000-0000-4000-8000-000000000000', type: 't', title: 'x', body: 'y', data: { code: 'ABC' } },
        }),
      ).rejects.toThrow(/not allowed/);
      await expect(
        outbox.enqueue(t.prisma, {
          topic: 'email.send',
          payload: { to: 'a@b.c', template: 'generic', data: { subject: 's', paragraphs: [], codeCiphertext: 'x' } as never },
        }),
      ).rejects.toThrow(/OtpMailer/);

      const raw = await t.prisma.outboxMessage.create({ data: { topic: 'email.send', payload: { data: { OTP: '1' } } } }).catch((e: unknown) => e);
      expect(mapDbError(raw)?.details).toMatchObject({ sqlState: '23514', constraint: 'ck_outbox_no_plain_otp' });

      const user = await createUser(t.prisma);
      const { outboxId } = await issueOtp(user, '111222');
      const sentWithCiphertext = await t.prisma.outboxMessage
        .update({ where: { id: outboxId }, data: { status: 'SENT' } })
        .catch((e: unknown) => e);
      expect(mapDbError(sentWithCiphertext)?.details).toMatchObject({ sqlState: '23514', constraint: 'ck_outbox_otp_scrubbed' });

      // OtpMailer refuses codes that do not match the stored hash (wiring mistakes)
      const other = `${user.id}@x.test`;
      await expect(
        t.prisma.runInTransaction(async (tx) => {
          const ch = await tx.emailChallenge.create({
            data: { userId: user.id, email: other, purpose: 'PASSWORD_RESET', codeHash: 'a'.repeat(64), expiresAt: new Date(Date.now() + 60_000) },
          });
          await t.get(OtpMailer).enqueue(tx, { challengeId: ch.id, code: '123456', email: other, purpose: 'PASSWORD_RESET' });
        }),
      ).rejects.toThrow(/code_hash/);
      await expect(
        t.prisma.runInTransaction(async (tx) => {
          const ch = await tx.emailChallenge.create({
            data: {
              userId: user.id,
              email: other,
              purpose: 'PASSWORD_RESET',
              codeHash: t.get(CryptoService).otpCodeHash('PASSWORD_RESET', other, '123456'),
              expiresAt: new Date(Date.now() + 60_000),
            },
          });
          await t.get(OtpMailer).enqueue(tx, { challengeId: ch.id, code: '123456', email: 'someone@else.test', purpose: 'PASSWORD_RESET' });
        }),
      ).rejects.toThrow(/do not match/);
    });

    it('undelivered OTP emails older than an hour are given up (DEAD, scrubbed) by the cleanup job', async () => {
      const user = await createUser(t.prisma);
      const { outboxId, challengeId } = await issueOtp(user, '333444');
      await t.prisma.outboxMessage.update({ where: { id: outboxId }, data: { createdAt: new Date(Date.now() - 2 * 3_600_000) } });
      expect(await t.get(OutboxCleanupJob).expireOtpMessages()).toBe(1);
      const row = await t.prisma.outboxMessage.findUniqueOrThrow({ where: { id: outboxId } });
      expect(row).toMatchObject({ status: 'DEAD', payload: { challengeId, template: 'otp' } });
    });
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

  it('AuditService.record: request context, programId, secrets stripped, PII masked', async () => {
    const user = await createUser(t.prisma, { roles: ['SUPER_ADMIN'] });
    const program = await createProgram(t.prisma);
    const auth: AuthContext = {
      userId: user.id,
      sessionId: '00000000-0000-4000-8000-000000000001',
      email: user.email,
      fullName: user.fullName,
      roles: ['MEMBER', 'SUPER_ADMIN'],
      permissions: new Set(),
      programScopes: [],
      isAdmin: true,
      mfaMethod: 'TOTP',
      mfaVerifiedAt: new Date(),
      hasTotpFactor: true,
      adminAccess: true,
      sessionExpiresAt: new Date(Date.now() + 3_600_000),
    };
    const audit = t.get(AuditService);
    const { id } = await RequestContext.run({ requestId: 'req-audit-123', ip: '10.0.0.1', auth }, () =>
      t.prisma.runInTransaction((tx) =>
        audit.record(tx, {
          action: 'program.update',
          resourceType: 'program',
          resourceId: program.id,
          programId: program.id,
          before: { email: 'anita@example.com', phone: '+919876543210', passwordHash: 'h', nested: { token: 't', ok: 1 } },
          after: { amountMinor: 5n, code: 'spring-2027', items: [{ codeCiphertext: 'x', secretEnc: 'y', label: 'x' }] },
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
      programId: program.id,
      before: { email: 'a***@e***.com', phone: '+**********10', nested: { ok: 1 } },
      after: { amountMinor: '5', code: 'spring-2027', items: [{ label: 'x' }] },
    });

    const system = await audit.record(t.prisma, { action: 'job.run', resourceType: 'job', actorUserId: null });
    expect((await t.prisma.auditLog.findUniqueOrThrow({ where: { id: system.id } })).actorRoles).toEqual(['SYSTEM']);

    // the DB itself rejects secret-looking keys
    const raw = await t.prisma.auditLog
      .create({ data: { action: 'x', resourceType: 'x', actorRoles: [], after: { secretEnc: 'v' } } })
      .catch((e: unknown) => e);
    expect(mapDbError(raw)?.details).toMatchObject({ sqlState: '23514', constraint: 'ck_audit_logs_no_secrets' });
  });

  describe('PlatformSettingsService', () => {
    it('creates the singleton on demand and caches until invalidate()', async () => {
      await t.prisma.platformSettings.deleteMany();
      const svc = t.get(PlatformSettingsService);
      svc.invalidate();
      const s = await svc.get();
      expect(s).toMatchObject({
        id: 1,
        rewardUnit: 'POINTS',
        currencyCode: 'INR',
        currencyMinorUnits: 2,
        pointsPerCurrencyUnit: 1,
        defaultRewardBudgetBps: 2000,
        payoutsEnabled: false,
        version: 1,
      });
      expect(toAmountFormat(s)).toEqual({ unit: 'POINTS', currencyCode: 'INR', minorUnits: 0, pointsLabel: 'Points' });

      await t.prisma.platformSettings.update({ where: { id: 1 }, data: { rewardUnit: 'MONEY' } });
      expect((await svc.get()).rewardUnit).toBe('POINTS'); // cached
      expect((await svc.get(t.prisma)).rewardUnit).toBe('MONEY'); // explicit db bypasses the cache
      svc.invalidate();
      expect(toAmountFormat(await svc.get())).toEqual({ unit: 'MONEY', currencyCode: 'INR', minorUnits: 2, pointsLabel: 'Points' });
    });

    it('update(): optimistic version bumped once by the DB trigger; currency minor units from `currencies`', async () => {
      const svc = t.get(PlatformSettingsService);
      const admin = await createUser(t.prisma, { roles: ['SUPER_ADMIN'] });
      const start = await svc.get(t.prisma);
      const { before, after } = await t.prisma.runInTransaction((tx) =>
        svc.update(tx, {
          expectedVersion: start.version,
          patch: { currencyCode: 'JPY', rewardUnit: 'MONEY', defaultRewardBudgetBps: 1500, pointsPerCurrencyUnit: 10, pointsLabel: 'Stars' },
          actorUserId: admin.id,
        }),
      );
      expect(before.version).toBe(start.version);
      expect(after).toMatchObject({
        version: start.version + 1,
        currencyCode: 'JPY',
        currencyMinorUnits: 0,
        rewardUnit: 'MONEY',
        defaultRewardBudgetBps: 1500,
        pointsPerCurrencyUnit: 10,
        pointsLabel: 'Stars',
        updatedById: admin.id,
      });
      // stale version → 409 STALE_VERSION
      await expect(
        t.prisma.runInTransaction((tx) => svc.update(tx, { expectedVersion: start.version, patch: { pointsLabel: 'X' }, actorUserId: admin.id })),
      ).rejects.toMatchObject({ code: 'STALE_VERSION' });
      await expect(
        t.prisma.runInTransaction((tx) => svc.update(tx, { expectedVersion: after.version, patch: { currencyCode: 'XXX' }, actorUserId: admin.id })),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      // budget default above the 50 % cap is rejected by the DB
      const capErr = await t.prisma
        .$transaction((tx) => svc.update(tx, { expectedVersion: after.version, patch: { defaultRewardBudgetBps: 5001 }, actorUserId: admin.id }))
        .catch((e: unknown) => e);
      expect(mapDbError(capErr)?.code).toBe('INVARIANT_VIOLATION');

      // a live program in JPY blocks switching the platform currency (DB trigger)
      await createProgram(t.prisma, { currencyCode: 'JPY' });
      const blocked = await t.prisma
        .$transaction((tx) => svc.update(tx, { expectedVersion: after.version, patch: { currencyCode: 'INR' }, actorUserId: admin.id }))
        .catch((e: unknown) => e);
      expect(mapDbError(blocked)?.details).toMatchObject({ sqlState: '23001' });
    });

    it('toRecordAmountFormat uses the record snapshot, never the live settings', () => {
      expect(toRecordAmountFormat({ rewardUnit: 'MONEY', currencyCode: 'JPY', currencyMinorUnits: 0 }, 'Points')).toEqual({
        unit: 'MONEY',
        currencyCode: 'JPY',
        minorUnits: 0,
        pointsLabel: 'Points',
      });
      expect(toRecordAmountFormat({ rewardUnit: 'POINTS', currencyCode: 'INR' }, 'Stars')).toEqual({
        unit: 'POINTS',
        currencyCode: 'INR',
        minorUnits: 0,
        pointsLabel: 'Stars',
      });
      expect(() => toRecordAmountFormat({ rewardUnit: 'MONEY', currencyCode: 'INR' }, 'P')).toThrow(/minor units/);
    });
  });

  it('seedSuperAdmin follows the registration protocol and is idempotent', async () => {
    const first = await seedSuperAdmin(t.prisma, { email: 'Root@Example.test', password: 'Sup3rSecret!' });
    expect(first.created).toBe(true);
    const again = await seedSuperAdmin(t.prisma, { email: 'root@example.test', password: 'Different123' });
    expect(again).toEqual({ ...first, created: false });
    const user = await t.prisma.user.findUniqueOrThrow({
      where: { id: first.userId },
      include: { roles: { include: { role: true } }, ancestorPaths: true, referralCodes: true },
    });
    expect(user.status).toBe('ACTIVE');
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.roles.map((r) => r.role.key).sort()).toEqual(['MEMBER', 'SUPER_ADMIN']);
    expect(user.ancestorPaths).toEqual([{ ancestorId: user.id, descendantId: user.id, depth: 0 }]);
    expect(user.referralCodes.map((c) => c.code)).toEqual([first.referralCode]);
  });
});
