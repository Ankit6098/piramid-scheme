import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AuthContext } from '../auth/auth-context';

/** Per-request data carried through async calls (AsyncLocalStorage). */
export interface RequestContextStore {
  readonly requestId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly method: string | null;
  readonly path: string | null;
  /** Set by SessionAuthGuard once the session is resolved. */
  auth: AuthContext | null;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,64}$/;

/**
 * Static accessors for the current request context. Outside a request (worker jobs, scripts) every
 * getter returns null; use `RequestContext.run()` to establish one (e.g. for a job with a synthetic
 * requestId).
 */
export const RequestContext = {
  current(): RequestContextStore | undefined {
    return storage.getStore();
  },
  get requestId(): string | null {
    return storage.getStore()?.requestId ?? null;
  },
  get ip(): string | null {
    return storage.getStore()?.ip ?? null;
  },
  get userAgent(): string | null {
    return storage.getStore()?.userAgent ?? null;
  },
  get auth(): AuthContext | null {
    return storage.getStore()?.auth ?? null;
  },
  setAuth(auth: AuthContext | null): void {
    const store = storage.getStore();
    if (store) store.auth = auth;
  },
  run<T>(store: Partial<RequestContextStore>, fn: () => T): T {
    return storage.run(
      {
        requestId: store.requestId ?? randomUUID(),
        ip: store.ip ?? null,
        userAgent: store.userAgent ?? null,
        method: store.method ?? null,
        path: store.path ?? null,
        auth: store.auth ?? null,
      },
      fn,
    );
  },
};

/** Accepts a client-supplied `x-request-id` only when it is short and safe; otherwise generates one. */
export function resolveRequestId(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return value && REQUEST_ID_RE.test(value) ? value : randomUUID();
}

/**
 * Express middleware (registered first in `configureApp`): assigns `req.id`, echoes `x-request-id`
 * on the response, and runs the rest of the pipeline inside the request context.
 */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = resolveRequestId(req.headers['x-request-id']);
  (req as Request & { id: string }).id = requestId;
  res.setHeader('x-request-id', requestId);
  const ua = req.headers['user-agent'];
  storage.run(
    {
      requestId,
      ip: req.ip ?? req.socket?.remoteAddress ?? null,
      userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null,
      method: req.method,
      path: req.path,
      auth: null,
    },
    () => next(),
  );
}
