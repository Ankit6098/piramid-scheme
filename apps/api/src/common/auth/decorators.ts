import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Permission } from '@app/shared';
import { unauthenticated } from '../errors/app-error';
import type { AuthContext } from './auth-context';

export const IS_PUBLIC_KEY = 'app:isPublic';
export const OPTIONAL_AUTH_KEY = 'app:optionalAuth';
export const REQUIRED_PERMISSIONS_KEY = 'app:requiredPermissions';

/** Route/controller needs no session. (SessionAuthGuard skips it entirely.) */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Route is public, but if a valid session cookie is present the AuthContext is resolved and available
 * via `@CurrentUser({ optional: true })`. Invalid/expired cookies are ignored (and cleared).
 */
export const OptionalAuth = () => SetMetadata(OPTIONAL_AUTH_KEY, true);

/** Requires an authenticated session holding ALL listed permissions (403 FORBIDDEN otherwise). */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);

export interface CurrentUserOptions {
  /** Return null instead of throwing 401 when there is no session (use with @OptionalAuth()). */
  optional?: boolean;
}

/**
 * Injects the request's `AuthContext`. Throws 401 when absent unless `{ optional: true }`.
 * @example  me(@CurrentUser() auth: AuthContext) { ... }
 */
export const CurrentUser = createParamDecorator(
  (options: CurrentUserOptions | undefined, ctx: ExecutionContext): AuthContext | null => {
    const req = ctx.switchToHttp().getRequest<{ auth?: AuthContext | null }>();
    const auth = req.auth ?? null;
    if (!auth && !options?.optional) throw unauthenticated();
    return auth;
  },
);
