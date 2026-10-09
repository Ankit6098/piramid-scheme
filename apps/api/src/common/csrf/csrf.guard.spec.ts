import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config/app-config';
import { AppError } from '../errors/app-error';
import { CsrfGuard, SKIP_CSRF_KEY, checkCsrf, type CsrfCheckInput } from './csrf.guard';

const allowedOrigins = ['http://localhost:3000', 'http://localhost:8080'];
const base: CsrfCheckInput = {
  method: 'POST',
  cookieToken: 'tok_1234567890abcdef',
  headerToken: 'tok_1234567890abcdef',
  origin: undefined,
  referer: undefined,
  allowedOrigins,
};

describe('checkCsrf', () => {
  it('lets safe methods through without tokens', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(checkCsrf({ ...base, method, cookieToken: undefined, headerToken: undefined }).ok).toBe(true);
    }
  });

  it('requires both cookie and header for mutations', () => {
    expect(checkCsrf({ ...base, cookieToken: undefined })).toEqual({ ok: false, reason: 'missing_token' });
    expect(checkCsrf({ ...base, headerToken: undefined })).toEqual({ ok: false, reason: 'missing_token' });
    expect(checkCsrf({ ...base, headerToken: '' })).toEqual({ ok: false, reason: 'missing_token' });
  });

  it('requires the header to equal the cookie', () => {
    expect(checkCsrf({ ...base, headerToken: 'tok_1234567890abcdeX' })).toEqual({ ok: false, reason: 'token_mismatch' });
    expect(checkCsrf({ ...base, headerToken: 'short' })).toEqual({ ok: false, reason: 'token_mismatch' });
    expect(checkCsrf(base)).toEqual({ ok: true });
  });

  it('checks Origin when present (exact origin match; "null" rejected)', () => {
    expect(checkCsrf({ ...base, origin: 'http://localhost:3000' }).ok).toBe(true);
    expect(checkCsrf({ ...base, origin: 'http://localhost:3001' })).toEqual({ ok: false, reason: 'origin_not_allowed' });
    expect(checkCsrf({ ...base, origin: 'https://localhost:3000' }).ok).toBe(false);
    expect(checkCsrf({ ...base, origin: 'null' }).ok).toBe(false);
    expect(checkCsrf({ ...base, origin: 'not a url' }).ok).toBe(false);
    // Origin wins over Referer
    expect(checkCsrf({ ...base, origin: 'https://evil.example', referer: 'http://localhost:3000/x' }).ok).toBe(false);
  });

  it('falls back to Referer when Origin is absent', () => {
    expect(checkCsrf({ ...base, referer: 'http://localhost:8080/admin/rewards?x=1' }).ok).toBe(true);
    expect(checkCsrf({ ...base, referer: 'https://evil.example/' })).toEqual({ ok: false, reason: 'referer_not_allowed' });
  });
});

describe('CsrfGuard', () => {
  const config = { app: { corsOrigins: allowedOrigins } } as unknown as AppConfig;

  function ctx(req: Record<string, unknown>, handlerMeta: Record<string, unknown> = {}): ExecutionContext {
    const handler = () => undefined;
    for (const [k, v] of Object.entries(handlerMeta)) Reflect.defineMetadata(k, v, handler);
    return {
      getType: () => 'http',
      getHandler: () => handler,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
  }

  const guard = new CsrfGuard(new Reflector(), config);

  it('throws 403 CSRF_FAILED for a mutation without tokens', () => {
    let caught: unknown;
    try {
      guard.canActivate(ctx({ method: 'POST', headers: {}, cookies: {} }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('CSRF_FAILED');
    expect((caught as AppError).httpStatus).toBe(403);
  });

  it('accepts a matching double-submit pair', () => {
    const req = { method: 'PATCH', headers: { 'x-csrf-token': 'abc123abc123', origin: 'http://localhost:3000' }, cookies: { csrf_token: 'abc123abc123' } };
    expect(guard.canActivate(ctx(req))).toBe(true);
  });

  it('skips GET and @SkipCsrf() routes', () => {
    expect(guard.canActivate(ctx({ method: 'GET', headers: {}, cookies: {} }))).toBe(true);
    expect(guard.canActivate(ctx({ method: 'POST', headers: {}, cookies: {} }, { [SKIP_CSRF_KEY]: true }))).toBe(true);
  });
});
