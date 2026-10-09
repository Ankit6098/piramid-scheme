import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { RequestContext } from '../context/request-context';
import { forbidden, mfaRequired } from '../errors/app-error';
import type { AuthContext } from './auth-context';
import { SESSION_COOKIE } from './cookies';
import { IS_PUBLIC_KEY, OPTIONAL_AUTH_KEY } from './decorators';
import { SessionAuthService } from './session-auth.service';
import { SessionTokenService } from './session-token.service';

export type AuthedRequest = Request & { auth?: AuthContext | null; id?: string };

/** `/api/v1/admin` and everything below it (matched on the registered route pattern). */
export function isAdminPath(path: string): boolean {
  return /^\/api\/v\d+\/admin(\/|$)/i.test(path);
}

/**
 * Global guard (APP_GUARD). Every route requires a valid session unless `@Public()`.
 * - `@OptionalAuth()` routes resolve the session when present but never fail.
 * - Routes under /api/v1/admin additionally require `isAdmin` (403 FORBIDDEN) and a session that
 *   completed MFA (403 MFA_REQUIRED).
 * Sets `req.auth` and `RequestContext.auth`.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionAuthService,
    private readonly tokens: SessionTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) === true;
    const optional = this.reflector.getAllAndOverride<boolean>(OPTIONAL_AUTH_KEY, targets) === true;
    if (isPublic && !optional) return true;

    const http = context.switchToHttp();
    const req = http.getRequest<AuthedRequest>();
    const res = http.getResponse<Response>();
    if (req.auth) return this.checkAdmin(req, req.auth);

    const token = (req.cookies as Record<string, string | undefined> | undefined)?.[SESSION_COOKIE];
    const result = await this.sessions.resolve(token);
    if (!result.ok) {
      if (result.clearCookie) this.tokens.clearSessionCookie(res);
      if (isPublic || optional) return true;
      throw result.error;
    }
    req.auth = result.auth;
    RequestContext.setAuth(result.auth);
    if (isPublic || optional) return true;
    return this.checkAdmin(req, result.auth);
  }

  private checkAdmin(req: AuthedRequest, auth: AuthContext): boolean {
    const routePath = (req.route as { path?: unknown } | undefined)?.path;
    const path = typeof routePath === 'string' ? routePath : req.path;
    if (isAdminPath(path) || isAdminPath(req.path)) {
      if (!auth.isAdmin) throw forbidden();
      if (!auth.mfaVerified) throw mfaRequired();
    }
    return true;
  }
}
