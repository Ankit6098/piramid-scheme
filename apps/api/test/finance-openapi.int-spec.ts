import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './utils/app';
import { disconnectTestPrisma } from './utils/db';

/** The finance DTOs (unions, refinements, string booleans) must not break the OpenAPI document. */
describe('finance routes in the OpenAPI document', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
    await disconnectTestPrisma();
  });

  it('builds the document with every finance route', () => {
    const doc = cleanupOpenApiDoc(SwaggerModule.createDocument(t.app, new DocumentBuilder().setTitle('test').build()));
    const paths = Object.keys(doc.paths);
    for (const p of [
      '/api/v1/admin/rewards',
      '/api/v1/admin/rewards/counts',
      '/api/v1/admin/rewards/{id}/approve',
      '/api/v1/admin/rewards/bulk-approve',
      '/api/v1/admin/events/{id}/reverse',
      '/api/v1/admin/ledger/transactions',
      '/api/v1/admin/ledger/accounts',
      '/api/v1/admin/ledger/summary',
      '/api/v1/admin/reconciliation',
      '/api/v1/users/me/rewards',
      '/api/v1/users/me/earnings',
    ]) {
      expect(paths).toContain(p);
    }
  });
});
