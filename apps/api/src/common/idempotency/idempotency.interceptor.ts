import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { catchError, from, mergeMap, Observable, of, throwError } from 'rxjs';
import type { AuthContext } from '../auth/auth-context';
import { unauthenticated } from '../errors/app-error';
import { IDEMPOTENCY_HEADER, parseIdempotencyKey } from './idempotency-key.decorator';
import { IdempotencyService } from './idempotency.service';
import { computeRequestHash } from './request-hash';

export const IDEMPOTENT_KEY = 'app:idempotent';
/** Response header set on a replayed response. */
export const IDEMPOTENT_REPLAYED_HEADER = 'idempotent-replayed';

export interface IdempotentOptions {
  /** Missing `Idempotency-Key` → 400 VALIDATION_FAILED. Default true; false = run without one. */
  required?: boolean;
  /** Operation id stored with the key. Default: `${method} ${route pattern}`. */
  route?: string;
}

/**
 * Makes an authenticated mutation idempotent via the `Idempotency-Key` header (stored in
 * `idempotency_keys`, scoped per user, 24 h):
 *
 *   @Post(':id/approve')
 *   @Idempotent()
 *   @RequirePermissions('rewards:approve')
 *   approve(@Param() p: IdParamDto, @CurrentUser() auth: AuthContext) { ... }
 *
 * First call runs the handler and stores its (successful) response; a retry with the same key and
 * the same request (method, route, params, query, body) gets the stored status + body back with
 * `Idempotent-Replayed: true`; the same key with a different request → 409 IDEMPOTENCY_CONFLICT;
 * while the first call is still running → 409 CONFLICT. Errors are not stored (the key is released).
 * Once the handler has succeeded the key is never released: if storing the response fails, the
 * handler's response is still returned and the key stays IN_PROGRESS (a retry gets 409 CONFLICT
 * instead of running the handler a second time).
 */
export const Idempotent = (options: IdempotentOptions = {}) => SetMetadata(IDEMPOTENT_KEY, options);

type IdemRequest = Request & { auth?: AuthContext | null };

/** Global interceptor (HttpCoreModule) — a no-op unless the route has `@Idempotent()`. */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly idempotency: IdempotencyService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const options = this.reflector.getAllAndOverride<IdempotentOptions | undefined>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options) return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<IdemRequest>();
    const res = http.getResponse<Response>();
    const key = parseIdempotencyKey(req.headers[IDEMPOTENCY_HEADER], options.required ?? true);
    if (!key) return next.handle();
    if (!req.auth) throw unauthenticated();

    const routePath = (req.route as { path?: unknown } | undefined)?.path;
    const route = options.route ?? `${req.method} ${typeof routePath === 'string' ? routePath : req.path}`;
    const requestHash = computeRequestHash({
      method: req.method,
      route,
      params: req.params ?? {},
      query: req.query ?? {},
      body: req.body ?? null,
    });
    const scope = { actorUserId: req.auth.userId, key };
    const begun = await this.idempotency.begin({ ...scope, route, requestHash });
    if (begun.state === 'replay') {
      res.status(begun.status);
      res.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
      return of(begun.body);
    }
    return next.handle().pipe(
      // Only handler errors release the key (nothing was committed, so a retry may run it again).
      catchError((err: unknown) =>
        from(this.idempotency.release(scope).catch(() => undefined)).pipe(mergeMap(() => throwError(() => err))),
      ),
      // The handler succeeded (and committed): store the response best-effort, never fail the request.
      mergeMap(async (body: unknown) => {
        await this.idempotency.completeBestEffort({ ...scope, status: res.statusCode, body });
        return body;
      }),
    );
  }
}
