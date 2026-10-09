import type { ModuleMetadata } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import request from 'supertest';
import type { Server } from 'node:http';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap/configure-app';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '../../src/common/auth/cookies';
import { randomToken } from '../../src/common/crypto/tokens';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { type AppConfigShape, parseConfig } from '../../src/config/app-config';
import { testDatabaseUrl } from './db';

export interface CreateTestAppOptions {
  /** Extra env vars (raw, as strings) applied on top of process.env before validation. */
  env?: Record<string, string>;
  /** Extra modules (e.g. test-only probe controllers). */
  imports?: ModuleMetadata['imports'];
}

export interface TestApp {
  app: NestExpressApplication;
  config: AppConfigShape;
  prisma: PrismaService;
  server: Server;
  /** Anonymous client (no session) that still handles the CSRF cookie/header for mutations. */
  client(): TestClient;
  /** Client carrying the given raw session token in the `sid` cookie. */
  clientWithSession(token: string): TestClient;
  get<T>(token: abstract new (...args: never[]) => T): T;
  close(): Promise<void>;
}

/**
 * Builds the test config: TEST_DATABASE_URL as DATABASE_URL, NODE_ENV=test, silent logs
 * (TEST_LOG_LEVEL=debug to see them), no in-process worker, and generous rate limits so suites that
 * call /auth/* many times do not flake. To test a limit, pass e.g. `{ THROTTLE_AUTH_LIMIT: '3' }`
 * (or use the per-route `@RateLimit(name, { limit, ttl })` override).
 */
export function testConfig(env: Record<string, string> = {}): AppConfigShape {
  return parseConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: testDatabaseUrl(),
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    RUN_WORKER_IN_API: 'false',
    DATABASE_POOL_MAX: '4',
    THROTTLE_STORAGE: 'memory',
    THROTTLE_DEFAULT_LIMIT: '100000',
    THROTTLE_AUTH_LIMIT: '100000',
    THROTTLE_OTP_LIMIT: '100000',
    ...env,
  });
}

/**
 * Creates a fully configured Nest app (same `configureApp` pipeline as main.ts) against
 * TEST_DATABASE_URL. Remember `await t.close()` in afterAll.
 */
export async function createTestApp(options: CreateTestAppOptions = {}): Promise<TestApp> {
  const config = testConfig(options.env);
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(config), ...(options.imports ?? [])],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApp(app, config, { swagger: false });
  await app.init();
  const server = app.getHttpServer() as Server;
  return {
    app,
    config,
    prisma: app.get(PrismaService),
    server,
    client: () => new TestClient(server),
    clientWithSession: (token: string) => new TestClient(server, { [SESSION_COOKIE]: token }),
    get: <T>(token: abstract new (...args: never[]) => T) => app.get(token as never) as T,
    close: () => app.close(),
  };
}

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/**
 * Minimal cookie-jar client over supertest. Every request carries the jar's cookies; mutating requests
 * also get a CSRF double-submit pair (`csrf_token` cookie = `x-csrf-token` header). Use
 * `.withoutCsrf()` to test CSRF rejection.
 */
export class TestClient {
  private csrf = true;
  readonly csrfToken = randomToken(32);

  constructor(
    private readonly server: Server,
    readonly cookies: Record<string, string> = {},
    readonly headers: Record<string, string> = {},
  ) {}

  /** Copy without automatic CSRF token/cookie. */
  withoutCsrf(): TestClient {
    const c = new TestClient(this.server, { ...this.cookies }, { ...this.headers });
    c.csrf = false;
    return c;
  }

  /** Copy with extra default headers (e.g. Origin). */
  withHeaders(headers: Record<string, string>): TestClient {
    const c = new TestClient(this.server, { ...this.cookies }, { ...this.headers, ...headers });
    c.csrf = this.csrf;
    return c;
  }

  get(url: string) {
    return this.build('get', url);
  }
  post(url: string) {
    return this.build('post', url);
  }
  put(url: string) {
    return this.build('put', url);
  }
  patch(url: string) {
    return this.build('patch', url);
  }
  delete(url: string) {
    return this.build('delete', url);
  }

  private build(method: Method, url: string): request.Test {
    let req = request(this.server)[method](url);
    const cookies = { ...this.cookies };
    const mutating = method !== 'get';
    if (this.csrf && mutating) cookies[CSRF_COOKIE] = this.csrfToken;
    const cookieHeader = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    if (cookieHeader) req = req.set('Cookie', cookieHeader);
    if (this.csrf && mutating) req = req.set(CSRF_HEADER, this.csrfToken);
    for (const [k, v] of Object.entries(this.headers)) req = req.set(k, v);
    return req;
  }
}
