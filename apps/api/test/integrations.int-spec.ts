import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiClientDto, CreatedApiClientDto, IntegrationSaleResultDto } from '@app/shared';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma, resetDatabase } from './utils/db';
import {
  createEnrollment,
  createPolicy,
  createProgram,
  createUser,
  factoryAdmin,
  loginAs,
  sha256,
  type LoggedInClient,
  type TestUser,
} from './utils/factories';

describe('integrations: API clients and machine sales ingestion', () => {
  let t: TestApp;
  let superAdmin: TestUser;
  let su: LoggedInClient;
  let seq = 0;

  beforeAll(async () => {
    t = await createTestApp();
  });
  beforeEach(async () => {
    await resetDatabase();
    await factoryAdmin(t.prisma);
    superAdmin = await createUser(t.prisma, { fullName: 'Sana Super', roles: ['SUPER_ADMIN'] });
    su = await loginAs(t, superAdmin);
  });
  afterAll(async () => {
    await t.close();
    await disconnectTestPrisma();
  });

  async function setup() {
    const program = await createProgram(t.prisma);
    const anita = await createUser(t.prisma, { fullName: 'Anita Sharma' });
    const priya = await createUser(t.prisma, { fullName: 'Priya Nair', sponsor: anita });
    await createEnrollment(t.prisma, { userId: anita.id, programId: program.id });
    await createPolicy(t.prisma, { programId: program.id });
    return { program, anita, priya };
  }

  async function newClient(programId: string, name = 'Storefront'): Promise<CreatedApiClientDto> {
    const res = await su.post('/api/v1/admin/integrations/clients').send({ programId, name });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data as CreatedApiClientDto;
  }

  const machine = (key?: string) => {
    const c = t.client().withoutCsrf();
    return key ? c.withHeaders({ Authorization: `Bearer ${key}` }) : c;
  };

  const saleBody = (subjectUserId: string, overrides: Record<string, unknown> = {}) => ({
    type: 'PRODUCT_SALE',
    externalId: `WEB-${++seq}`,
    customerReference: 'cust_981',
    subjectUserId,
    amountMinor: '80000',
    occurredAt: new Date().toISOString(),
    ...overrides,
  });

  describe('client management', () => {
    it('shows the key once and stores only its hash and prefix', async () => {
      const { program } = await setup();
      const created = await newClient(program.id);
      expect(created.apiKey).toMatch(/^rpk_[A-Za-z0-9_-]{43}$/);
      expect(created.client).toMatchObject({
        name: 'Storefront',
        status: 'ACTIVE',
        keyPrefix: created.apiKey.slice(0, 12),
        program: { id: program.id },
        createdBy: { id: superAdmin.id },
        lastUsedAt: null,
      });
      const row = await t.prisma.apiClient.findUniqueOrThrow({ where: { id: created.client.id } });
      expect(row.keyHash).toBe(sha256(created.apiKey));
      expect(JSON.stringify(row)).not.toContain(created.apiKey);

      const list = await su.get('/api/v1/admin/integrations/clients');
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(1);
      expect(JSON.stringify(list.body)).not.toContain(created.apiKey);
      expect(JSON.stringify(list.body)).not.toContain(row.keyHash);

      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'api_client.create', resourceId: created.client.id } });
      expect(audit.programId).toBe(program.id);
      expect(JSON.stringify(audit)).not.toContain(created.apiKey);
    });

    it('is reserved to holders of integrations:manage', async () => {
      const { program } = await setup();
      const pa = await loginAs(t, await createUser(t.prisma, { roles: ['PROGRAM_ADMIN'], programScopes: [program.id] }));
      const res = await pa.post('/api/v1/admin/integrations/clients').send({ programId: program.id, name: 'Nope' });
      expect(res.status).toBe(403);
      expect((await pa.get('/api/v1/admin/integrations/clients')).status).toBe(403);
      expect((await su.post('/api/v1/admin/integrations/clients').send({ programId: program.id, name: ' ' })).status).toBe(400);
    });

    it('revokes a key once and filters by status', async () => {
      const { program } = await setup();
      const a = await newClient(program.id, 'Client A');
      await newClient(program.id, 'Client B');
      const res = await su.post(`/api/v1/admin/integrations/clients/${a.client.id}/revoke`).send({ reason: 'Key leaked in a log file' });
      expect(res.status).toBe(200);
      expect((res.body.data as ApiClientDto).status).toBe('REVOKED');
      expect((await su.post(`/api/v1/admin/integrations/clients/${a.client.id}/revoke`).send({})).status).toBe(409);
      const revoked = await su.get('/api/v1/admin/integrations/clients?status=REVOKED');
      expect(revoked.body.data.map((c: ApiClientDto) => c.name)).toEqual(['Client A']);
      const active = await su.get('/api/v1/admin/integrations/clients?status=ACTIVE');
      expect(active.body.data.map((c: ApiClientDto) => c.name)).toEqual(['Client B']);
    });
  });

  describe('ingestion', () => {
    it('records a sale with an API key (no cookies, no CSRF), idempotently', async () => {
      const { program, anita, priya } = await setup();
      const { apiKey, client } = await newClient(program.id);
      const body = saleBody(priya.id);
      const res = await machine(apiKey).post('/api/v1/integrations/events').send(body);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const data = res.body.data as IntegrationSaleResultDto;
      expect(data).toMatchObject({ programId: program.id, revision: 0, status: 'PROCESSED', outcome: 'REWARDS_CREATED', replayed: false });
      // Minimal machine view: no member or reward details.
      expect(Object.keys(data)).not.toEqual(expect.arrayContaining(['subject', 'rewards', 'customerReference']));

      const event = await t.prisma.qualifyingEvent.findUniqueOrThrow({ where: { id: data.id } });
      expect(event).toMatchObject({ source: 'API', apiClientId: client.id, recordedById: null });
      const rewards = await t.prisma.reward.findMany({ where: { eventId: data.id } });
      expect(rewards.map((r) => [r.recipientUserId, r.amountMinor, r.status])).toEqual([[anita.id, 8_000n, 'PENDING_APPROVAL']]);
      expect((await t.prisma.apiClient.findUniqueOrThrow({ where: { id: client.id } })).lastUsedAt).not.toBeNull();
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'event.record', resourceId: data.id } });
      expect(audit).toMatchObject({ actorUserId: null, actorRoles: ['API_CLIENT'], programId: program.id });

      const replay = await machine(apiKey).post('/api/v1/integrations/events').send(body);
      expect(replay.status).toBe(200);
      expect(replay.body.data).toMatchObject({ id: data.id, replayed: true });
      const conflict = await machine(apiKey).post('/api/v1/integrations/events').send({ ...body, customerReference: 'someone-else' });
      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('auto-approves and posts integration sales under a no-approval policy', async () => {
      const program = await createProgram(t.prisma);
      const anita = await createUser(t.prisma);
      const priya = await createUser(t.prisma, { sponsor: anita });
      await createEnrollment(t.prisma, { userId: anita.id, programId: program.id });
      await createPolicy(t.prisma, { programId: program.id, requiresApproval: false });
      const { apiKey } = await newClient(program.id);
      const res = await machine(apiKey).post('/api/v1/integrations/events').send(saleBody(priya.id));
      expect(res.status).toBe(201);
      const rewards = await t.prisma.reward.findMany({ where: { eventId: res.body.data.id } });
      expect(rewards.map((r) => r.status)).toEqual(['POSTED']);
    });

    it('rejects missing, unknown and revoked keys with 401 before validating the body', async () => {
      const { program, priya } = await setup();
      const { apiKey, client } = await newClient(program.id);
      expect((await machine().post('/api/v1/integrations/events').send(saleBody(priya.id))).status).toBe(401);
      const unknown = await machine('rpk_' + 'x'.repeat(43)).post('/api/v1/integrations/events').send({ nonsense: true });
      expect(unknown.status).toBe(401);
      expect(unknown.body.error.code).toBe('UNAUTHENTICATED');

      await su.post(`/api/v1/admin/integrations/clients/${client.id}/revoke`).send({});
      const revoked = await machine(apiKey).post('/api/v1/integrations/events').send(saleBody(priya.id));
      expect(revoked.status).toBe(401);
      expect(await t.prisma.qualifyingEvent.count()).toBe(0);
    });

    it('confines a key to its program and validates the body', async () => {
      const { program, priya } = await setup();
      const other = await createProgram(t.prisma);
      const { apiKey } = await newClient(program.id);
      const wrong = await machine(apiKey).post('/api/v1/integrations/events').send(saleBody(priya.id, { programId: other.id }));
      expect(wrong.status).toBe(403);
      const explicit = await machine(apiKey).post('/api/v1/integrations/events').send(saleBody(priya.id, { programId: program.id }));
      expect(explicit.status).toBe(201);
      const invalid = await machine(apiKey).post('/api/v1/integrations/events').send(saleBody(priya.id, { amountMinor: 12.5 }));
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe('VALIDATION_FAILED');
      // A session cookie is not an API credential.
      const cookieOnly = await su.post('/api/v1/integrations/events').send(saleBody(priya.id));
      expect(cookieOnly.status).toBe(401);
    });
  });
});
