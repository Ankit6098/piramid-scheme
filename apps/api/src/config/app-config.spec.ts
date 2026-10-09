import { describe, expect, it } from 'vitest';
import { ConfigValidationError, parseConfig } from './app-config';

const valid = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/referral?schema=public',
  OTP_PEPPER: 'a'.repeat(64),
  CORS_ORIGINS: 'http://localhost:3000, http://localhost:8080/',
  APP_PUBLIC_URL: 'http://localhost:8080',
};

describe('parseConfig', () => {
  it('parses a valid env with defaults', () => {
    const c = parseConfig(valid);
    expect(c.app.port).toBe(4000);
    expect(c.app.corsOrigins).toEqual(['http://localhost:3000', 'http://localhost:8080']);
    expect(c.app.trustProxy).toBe(false);
    expect(c.security.cookieSecure).toBe(false);
    expect(c.worker.runInApi).toBe(false);
    expect(c.throttle.default).toEqual({ limit: 300, ttlMs: 60_000 });
    expect(c.mail.user).toBeUndefined();
  });

  it('parses booleans, numbers and TRUST_PROXY variants', () => {
    expect(parseConfig({ ...valid, TRUST_PROXY: 'true' }).app.trustProxy).toBe(1);
    expect(parseConfig({ ...valid, TRUST_PROXY: '2' }).app.trustProxy).toBe(2);
    expect(parseConfig({ ...valid, TRUST_PROXY: 'loopback' }).app.trustProxy).toBe('loopback');
    expect(parseConfig({ ...valid, RUN_WORKER_IN_API: 'true', COOKIE_SECURE: '1' }).worker.runInApi).toBe(true);
    expect(parseConfig({ ...valid, SMTP_USER: '' }).mail.user).toBeUndefined();
  });

  it('fails fast with every problem listed', () => {
    let caught: unknown;
    try {
      parseConfig({ NODE_ENV: 'staging', OTP_PEPPER: 'short', API_PORT: 'abc' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    const msg = (caught as Error).message;
    for (const key of ['NODE_ENV', 'DATABASE_URL', 'OTP_PEPPER', 'API_PORT']) expect(msg).toContain(key);
  });

  it('requires a 64-hex OTP_PEPPER in production', () => {
    expect(() => parseConfig({ ...valid, NODE_ENV: 'production', OTP_PEPPER: 'z'.repeat(64) })).toThrow(/64 hex/);
    expect(parseConfig({ ...valid, NODE_ENV: 'production', OTP_PEPPER: 'ab'.repeat(32) }).isProduction).toBe(true);
  });

  it('rejects invalid CORS origins', () => {
    expect(() => parseConfig({ ...valid, CORS_ORIGINS: 'not-a-url' })).toThrow(/CORS_ORIGINS/);
  });
});
