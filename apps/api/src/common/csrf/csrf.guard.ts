import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppConfig } from '../../config/app-config';
import { CSRF_COOKIE, CSRF_HEADER } from '../auth/cookies';
import { safeEqual } from '../crypto/tokens';
import { csrfFailed } from '../errors/app-error';

export const SKIP_CSRF_KEY = 'app:skipCsrf';

/**
 * Opt a route out of CSRF checks — ONLY for non-browser callers that authenticate otherwise
 * (e.g. signed webhooks). Never use it on cookie-authenticated routes.
 */
export const SkipCsrf = () => SetMetadata(SKIP_CSRF_KEY, true);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface CsrfCheckInput {
  method: string;
  cookieToken: string | undefined;
  headerToken: string | undefined;
  origin: string | undefined;
  referer: string | undefined;
  allowedOrigins: readonly string[];
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Pure double-submit + Origin check (unit-tested).
 * - Safe methods always pass.
 * - `x-csrf-token` must equal the `csrf_token` cookie (constant-time).
 * - When `Origin` is present it must be an allowed origin ("null" is rejected); otherwise when
 *   `Referer` is present its origin must be allowed. Requests with neither header (non-browser
 *   clients) rely on the token alone.
 */
export function checkCsrf(input: CsrfCheckInput): { ok: true } | { ok: false; reason: string } {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return { ok: true };
  if (!input.cookieToken || !input.headerToken) return { ok: false, reason: 'missing_token' };
  if (!safeEqual(input.cookieToken, input.headerToken)) return { ok: false, reason: 'token_mismatch' };
  const allowed = new Set(input.allowedOrigins);
  if (input.origin !== undefined) {
    const o = input.origin === 'null' ? null : originOf(input.origin);
    if (!o || !allowed.has(o)) return { ok: false, reason: 'origin_not_allowed' };
  } else if (input.referer !== undefined) {
    const o = originOf(input.referer);
    if (!o || !allowed.has(o)) return { ok: false, reason: 'referer_not_allowed' };
  }
  return { ok: true };
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Global guard (APP_GUARD) enforcing CSRF protection on every mutating request. */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: AppConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_CSRF_KEY, [context.getHandler(), context.getClass()]);
    if (skip) return true;
    const result = checkCsrf({
      method: req.method,
      cookieToken: (req.cookies as Record<string, string | undefined> | undefined)?.[CSRF_COOKIE],
      headerToken: headerValue(req.headers[CSRF_HEADER]),
      origin: headerValue(req.headers.origin),
      referer: headerValue(req.headers.referer),
      allowedOrigins: this.config.app.corsOrigins,
    });
    if (!result.ok) throw csrfFailed();
    return true;
  }
}
