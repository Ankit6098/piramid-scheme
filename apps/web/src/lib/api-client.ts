/**
 * Typed browser fetch wrapper for the REST API (`/api/v1`, same origin — Next rewrites or nginx
 * forward it to the NestJS API so the `sid` session cookie is first-party).
 *
 * - Success envelopes: `{ data: T }` → `api.get<T>()` resolves to `T`;
 *   lists: `{ data: T[], page }` → `api.getPage<T>()` resolves to `ApiPage<T>`.
 * - Errors: `{ error: { code, message, details?, requestId } }` → thrown as `ApiError`.
 * - Mutations (POST/PUT/PATCH/DELETE) send the CSRF double-submit header and retry once on
 *   `CSRF_FAILED` with a fresh token.
 * - Financial mutations can pass `idempotencyKey` (create it ONCE per user intent with
 *   `createIdempotencyKey()` so a retry reuses the same key).
 *
 * Browser-only: the base URL is relative and auth relies on cookies. Do not call from Server
 * Components (there is no session to forward there).
 */
import { ErrorCode, type ApiErrorBody, type ApiPage } from '@app/shared';

import { CSRF_COOKIE, CSRF_HEADER } from '@/config/routes';
import type { CsrfResponse } from '@/lib/types';

export const API_BASE_PATH = '/api/v1';

/** Pseudo error codes produced by the client itself (never sent by the API). */
export const ClientErrorCode = {
  Network: 'NETWORK_ERROR',
  InvalidResponse: 'INVALID_RESPONSE',
} as const;

export type QueryValue = string | number | boolean | bigint | null | undefined;
export type QueryParams = Record<string, QueryValue | readonly QueryValue[]>;

export interface RequestOptions extends Omit<RequestInit, 'body' | 'method' | 'headers'> {
  /** Query-string params. `undefined`, `null` and `""` are skipped; arrays repeat the key. */
  query?: QueryParams;
  /** JSON body (bigint values are serialized as decimal strings). `FormData` is sent as-is. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Sent as `Idempotency-Key` (financial mutations). */
  idempotencyKey?: string;
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// ─── ApiError ────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  override readonly name = 'ApiError';
  /** Machine-readable code (`ErrorCode` from `@app/shared`, or a `ClientErrorCode`). */
  readonly code: string;
  /** HTTP status (0 for network failures). */
  readonly status: number;
  readonly details: unknown;
  readonly requestId: string | undefined;
  /** Field-level validation messages keyed by dotted path (`"rules.0.percentageBps"`). */
  readonly fieldErrors: Record<string, string>;

  constructor(init: {
    code: string;
    message: string;
    status: number;
    details?: unknown;
    requestId?: string;
  }) {
    super(init.message);
    this.code = init.code;
    this.status = init.status;
    this.details = init.details;
    this.requestId = init.requestId;
    this.fieldErrors = extractFieldErrors(init.details);
  }

  get isUnauthenticated(): boolean {
    return this.status === 401 || this.code === ErrorCode.Unauthenticated;
  }
  get isForbidden(): boolean {
    return this.status === 403 && this.code !== ErrorCode.CsrfFailed;
  }
  get isMfaRequired(): boolean {
    return this.code === ErrorCode.MfaRequired;
  }
  get isNotFound(): boolean {
    return this.status === 404 || this.code === ErrorCode.NotFound;
  }
  get isValidation(): boolean {
    return this.code === ErrorCode.ValidationFailed || this.status === 422;
  }
  get isConflict(): boolean {
    return this.status === 409;
  }
  get isRateLimited(): boolean {
    return this.status === 429 || this.code === ErrorCode.RateLimited;
  }
  get isNetworkError(): boolean {
    return this.code === ClientErrorCode.Network;
  }
  get hasFieldErrors(): boolean {
    return Object.keys(this.fieldErrors).length > 0;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

const STATUS_FALLBACK: Record<number, { code: string; message: string }> = {
  400: { code: ErrorCode.ValidationFailed, message: 'The request was invalid.' },
  401: { code: ErrorCode.Unauthenticated, message: 'Please sign in to continue.' },
  403: { code: ErrorCode.Forbidden, message: "You don't have permission to do that." },
  404: { code: ErrorCode.NotFound, message: "We couldn't find what you were looking for." },
  409: {
    code: ErrorCode.Conflict,
    message: 'This conflicts with the current state. Refresh and try again.',
  },
  422: { code: ErrorCode.ValidationFailed, message: 'Some fields need attention.' },
  429: {
    code: ErrorCode.RateLimited,
    message: 'Too many attempts. Please wait a moment and try again.',
  },
};

/** A user-presentable message for any thrown value (toasts, inline alerts). */
export function getErrorMessage(
  error: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  if (isApiError(error)) return error.message || fallback;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/**
 * Normalizes the API's validation `details` into `{ "dotted.path": "message" }`. Accepts the shapes
 * nestjs-zod / Zod produce: an issues array (`[{ path, message }]`), `{ issues: [...] }`,
 * `{ fieldErrors: { field: string[] } }` (`z.flattenError`) or a plain `{ field: message }` map.
 */
export function extractFieldErrors(details: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  const add = (path: unknown, message: unknown) => {
    if (typeof message !== 'string' || !message) return;
    const key = Array.isArray(path)
      ? path.map(String).join('.')
      : typeof path === 'string'
        ? path
        : '';
    if (key && !(key in result)) result[key] = message;
  };

  const fromIssues = (issues: unknown[]) => {
    for (const issue of issues) {
      if (issue && typeof issue === 'object') {
        const i = issue as { path?: unknown; field?: unknown; message?: unknown };
        add(i.path ?? i.field, i.message);
      }
    }
  };

  if (Array.isArray(details)) {
    fromIssues(details);
  } else if (details && typeof details === 'object') {
    const d = details as Record<string, unknown>;
    if (Array.isArray(d.issues)) fromIssues(d.issues);
    else if (Array.isArray(d.errors)) fromIssues(d.errors);
    const fieldErrors = d.fieldErrors;
    if (fieldErrors && typeof fieldErrors === 'object') {
      for (const [key, value] of Object.entries(fieldErrors as Record<string, unknown>)) {
        add(key, Array.isArray(value) ? value[0] : value);
      }
    }
    if (!d.issues && !d.errors && !d.fieldErrors) {
      for (const [key, value] of Object.entries(d)) {
        add(key, Array.isArray(value) ? value[0] : value);
      }
    }
  }
  return result;
}

// ─── CSRF ────────────────────────────────────────────────────────────────────

let csrfToken: string | null = null;
let csrfRequest: Promise<string | null> | null = null;

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const [rawKey, ...rest] = part.trim().split('=');
    if (rawKey === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return rest.join('=');
      }
    }
  }
  return null;
}

async function fetchCsrfToken(): Promise<string | null> {
  const response = await fetch(`${API_BASE_PATH}/auth/csrf`, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw await toApiError(response);
  const body = (await safeJson(response)) as { data?: Partial<CsrfResponse> } | null;
  return body?.data?.csrfToken ?? readCookie(CSRF_COOKIE);
}

/** Current CSRF token: the readable cookie wins (it follows server-side rotation), else a fetched one. */
async function getCsrfToken(forceRefresh = false): Promise<string | null> {
  if (forceRefresh) {
    csrfToken = null;
  } else {
    const fromCookie = readCookie(CSRF_COOKIE);
    if (fromCookie) return fromCookie;
    if (csrfToken) return csrfToken;
  }
  csrfRequest ??= fetchCsrfToken()
    .then((token) => {
      csrfToken = token;
      return token;
    })
    .finally(() => {
      csrfRequest = null;
    });
  return csrfRequest;
}

/** Forget the cached CSRF token (call after logout / login if the server rotates it). */
export function resetCsrfToken(): void {
  csrfToken = null;
}

// ─── Core request ────────────────────────────────────────────────────────────

export function buildUrl(path: string, query?: QueryParams): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const url = normalized.startsWith(API_BASE_PATH) ? normalized : `${API_BASE_PATH}${normalized}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(query)) {
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values as QueryValue[]) {
      if (value === undefined || value === null || value === '') continue;
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

function serializeBody(body: unknown): BodyInit | undefined {
  if (body === undefined) return undefined;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return body;
  return JSON.stringify(body, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  const body = (await safeJson(response)) as Partial<ApiErrorBody> | null;
  const headerRequestId = response.headers.get('x-request-id') ?? undefined;
  const fallback = STATUS_FALLBACK[response.status] ?? {
    code: ErrorCode.Internal,
    message: 'The server had a problem handling this request. Please try again.',
  };
  const err = body?.error;
  return new ApiError({
    code: err?.code ?? fallback.code,
    message: err?.message ?? fallback.message,
    status: response.status,
    details: err?.details,
    requestId: err?.requestId ?? headerRequestId,
  });
}

/**
 * Low-level request returning the parsed JSON body (envelope included). Prefer the `api.*` helpers.
 */
export async function apiRequest<TBody = unknown>(
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<TBody> {
  const { query, body, headers: extraHeaders, idempotencyKey, ...init } = options;
  const upper = method.toUpperCase();
  const isMutation = MUTATING_METHODS.has(upper);
  const url = buildUrl(path, query);

  const send = async (forceCsrfRefresh: boolean): Promise<Response> => {
    const headers: Record<string, string> = { Accept: 'application/json', ...extraHeaders };
    const payload = serializeBody(body);
    if (payload !== undefined && typeof payload === 'string')
      headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    if (isMutation) {
      const token = await getCsrfToken(forceCsrfRefresh);
      if (token) headers[CSRF_HEADER] = token;
    }
    try {
      return await fetch(url, {
        cache: 'no-store',
        ...init,
        method: upper,
        headers,
        body: payload,
        credentials: 'include',
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ApiError({
        code: ClientErrorCode.Network,
        message: "Can't reach the server. Check your connection and try again.",
        status: 0,
      });
    }
  };

  let response = await send(false);
  if (!response.ok && isMutation && response.status === 403) {
    const error = await toApiError(response.clone());
    if (error.code === ErrorCode.CsrfFailed) {
      response = await send(true);
    }
  }

  if (!response.ok) throw await toApiError(response);
  if (response.status === 204 || response.status === 205) return undefined as TBody;
  const text = await response.text();
  if (!text) return undefined as TBody;
  try {
    return JSON.parse(text) as TBody;
  } catch {
    throw new ApiError({
      code: ClientErrorCode.InvalidResponse,
      message: 'The server sent an unexpected response.',
      status: response.status,
      requestId: response.headers.get('x-request-id') ?? undefined,
    });
  }
}

function unwrap<T>(body: unknown): T {
  if (body && typeof body === 'object' && 'data' in body) return (body as { data: T }).data;
  return body as T;
}

/** Typed API helpers. Paths are relative to `/api/v1` (e.g. `api.get("/rewards/summary")`). */
export const api = {
  /** GET a single resource → unwrapped `data`. */
  get: async <T>(path: string, options?: RequestOptions): Promise<T> =>
    unwrap<T>(await apiRequest('GET', path, options)),
  /** GET a cursor page → `{ data: T[], page: { nextCursor, limit } }`. */
  getPage: async <T>(path: string, options?: RequestOptions): Promise<ApiPage<T>> => {
    const body = await apiRequest<ApiPage<T> | null>('GET', path, options);
    return {
      data: body?.data ?? [],
      page: body?.page ?? { nextCursor: null, limit: Number(options?.query?.limit ?? 0) || 0 },
    };
  },
  post: async <T = void>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
    unwrap<T>(await apiRequest('POST', path, { ...options, body })),
  put: async <T = void>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
    unwrap<T>(await apiRequest('PUT', path, { ...options, body })),
  patch: async <T = void>(path: string, body?: unknown, options?: RequestOptions): Promise<T> =>
    unwrap<T>(await apiRequest('PATCH', path, { ...options, body })),
  delete: async <T = void>(path: string, options?: RequestOptions): Promise<T> =>
    unwrap<T>(await apiRequest('DELETE', path, options)),
};

/** New random `Idempotency-Key`. Generate once per user intent (e.g. when a dialog opens). */
export function createIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
