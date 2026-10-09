import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@app/shared';
import { forbidden, unauthenticated } from '../errors/app-error';
import type { AuthContext } from './auth-context';
import { REQUIRED_PERMISSIONS_KEY } from './decorators';

/** Pure check used by the guard (unit-tested). Throws 401/403 AppErrors. */
export function assertPermissions(auth: AuthContext | null | undefined, required: readonly Permission[]): void {
  if (required.length === 0) return;
  if (!auth) throw unauthenticated();
  const missing = required.filter((p) => !auth.permissions.has(p));
  if (missing.length) throw forbidden(undefined, { missingPermissions: missing });
}

/**
 * Global guard (APP_GUARD, after SessionAuthGuard). Enforces `@RequirePermissions(...)` — ALL listed
 * permissions are required. Method-level metadata overrides class-level metadata.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(REQUIRED_PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;
    const req = context.switchToHttp().getRequest<{ auth?: AuthContext | null }>();
    assertPermissions(req.auth, required);
    return true;
  }
}
