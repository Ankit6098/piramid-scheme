import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { ErrorCode, type ApiErrorBody } from '@app/shared';
import type { Response } from 'express';
import { ZodValidationException } from 'nestjs-zod';
import { ZodError } from 'zod';
import { RequestContext } from '../context/request-context';
import { toJsonSafe } from '../http/json-safe';
import { AppError } from './app-error';
import { mapDbError } from './db-error';

export interface ValidationIssue {
  path: string;
  message: string;
  code: string;
}

/** Flattens zod issues into `{ path: "a.b.0", message, code }` entries for `details.issues`. */
export function zodIssues(error: unknown): ValidationIssue[] {
  if (error instanceof ZodError) {
    return error.issues.map((i) => ({
      path: i.path.map(String).join('.'),
      message: i.message,
      code: i.code,
    }));
  }
  const issues = (error as { issues?: Array<{ path?: unknown[]; message?: string; code?: string }> } | null)?.issues;
  if (Array.isArray(issues)) {
    return issues.map((i) => ({
      path: (i.path ?? []).map(String).join('.'),
      message: i.message ?? 'Invalid value',
      code: i.code ?? 'custom',
    }));
  }
  return [];
}

const STATUS_CODES: Record<number, ErrorCode> = {
  400: ErrorCode.ValidationFailed,
  401: ErrorCode.Unauthenticated,
  403: ErrorCode.Forbidden,
  404: ErrorCode.NotFound,
  405: ErrorCode.NotFound,
  409: ErrorCode.Conflict,
  413: ErrorCode.PayloadTooLarge,
  415: ErrorCode.ValidationFailed,
  422: ErrorCode.ValidationFailed,
  429: ErrorCode.RateLimited,
  501: ErrorCode.NotImplemented,
  503: ErrorCode.ServiceUnavailable,
};

const DEFAULT_MESSAGES: Partial<Record<ErrorCode, string>> = {
  [ErrorCode.ValidationFailed]: 'The request is invalid',
  [ErrorCode.Unauthenticated]: 'Please sign in to continue',
  [ErrorCode.Forbidden]: 'You do not have permission to perform this action',
  [ErrorCode.NotFound]: 'Not found',
  [ErrorCode.Conflict]: 'The request conflicts with the current state',
  [ErrorCode.PayloadTooLarge]: 'The request body is too large',
  [ErrorCode.RateLimited]: 'Too many requests. Please try again later',
  [ErrorCode.NotImplemented]: 'This feature is not available yet',
  [ErrorCode.ServiceUnavailable]: 'Service temporarily unavailable',
  [ErrorCode.Internal]: 'An unexpected error occurred',
};

export interface NormalizedError {
  status: number;
  code: ErrorCode;
  message: string;
  details?: unknown;
  /** True when the error is unexpected (5xx) and should be logged with its stack. */
  unexpected: boolean;
}

/** Pure mapping from any thrown value to the public error shape (unit-tested). */
export function normalizeError(exception: unknown): NormalizedError {
  if (exception instanceof AppError) {
    return {
      status: exception.httpStatus,
      code: exception.code,
      message: exception.message,
      details: exception.details,
      unexpected: exception.httpStatus >= 500 && exception.httpStatus !== 501 && exception.httpStatus !== 503,
    };
  }
  if (exception instanceof ZodValidationException) {
    return {
      status: 400,
      code: ErrorCode.ValidationFailed,
      message: 'The request is invalid',
      details: { issues: zodIssues(exception.getZodError()) },
      unexpected: false,
    };
  }
  if (exception instanceof ZodError) {
    return {
      status: 400,
      code: ErrorCode.ValidationFailed,
      message: 'The request is invalid',
      details: { issues: zodIssues(exception) },
      unexpected: false,
    };
  }
  if (exception instanceof ThrottlerException) {
    return { status: 429, code: ErrorCode.RateLimited, message: DEFAULT_MESSAGES[ErrorCode.RateLimited]!, unexpected: false };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const code = STATUS_CODES[status] ?? (status >= 500 ? ErrorCode.Internal : ErrorCode.ValidationFailed);
    let message = DEFAULT_MESSAGES[code] ?? 'Request failed';
    // 4xx messages from Nest/Express (e.g. "Cannot GET /x", JSON parse errors) are safe to echo in
    // generic form only; never echo 5xx messages.
    if (status === 404) message = 'Not found';
    if (status === 400) {
      const resp = exception.getResponse();
      const raw = typeof resp === 'string' ? resp : (resp as { message?: unknown }).message;
      if (typeof raw === 'string' && /JSON/i.test(raw)) message = 'Malformed JSON body';
    }
    return { status, code, message, unexpected: status >= 500 && status !== 501 && status !== 503 };
  }
  // body-parser errors (too large / malformed) arrive as plain errors carrying `status`/`type`.
  const bodyErr = exception as { status?: unknown; type?: unknown } | null;
  if (bodyErr && typeof bodyErr === 'object' && typeof bodyErr.type === 'string' && typeof bodyErr.status === 'number') {
    if (bodyErr.status === 413) {
      return { status: 413, code: ErrorCode.PayloadTooLarge, message: DEFAULT_MESSAGES[ErrorCode.PayloadTooLarge]!, unexpected: false };
    }
    if (bodyErr.status >= 400 && bodyErr.status < 500) {
      return {
        status: 400,
        code: ErrorCode.ValidationFailed,
        message: bodyErr.type === 'entity.parse.failed' ? 'Malformed JSON body' : 'The request body is invalid',
        unexpected: false,
      };
    }
  }
  const db = mapDbError(exception);
  if (db) {
    return { status: db.httpStatus, code: db.code, message: db.message, details: db.details, unexpected: db.httpStatus >= 500 };
  }
  return { status: HttpStatus.INTERNAL_SERVER_ERROR, code: ErrorCode.Internal, message: DEFAULT_MESSAGES[ErrorCode.Internal]!, unexpected: true };
}

/**
 * Global exception filter → `{ error: { code, message, details?, requestId } }`.
 * Unknown errors become 500 INTERNAL_ERROR without leaking internals (the stack is logged).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const res = host.switchToHttp().getResponse<Response>();
    const n = normalizeError(exception);
    const requestId = RequestContext.requestId ?? (host.switchToHttp().getRequest<{ id?: string }>().id ?? undefined);

    if (n.unexpected) {
      this.logger.error({ err: exception, requestId }, 'Unhandled error');
    } else if (n.status >= 500) {
      this.logger.warn({ errorCode: n.code, requestId, err: exception }, n.message);
    }

    if (res.headersSent) return;
    if (n.status === 429 && !res.getHeader('retry-after')) res.setHeader('retry-after', '60');
    const body: ApiErrorBody = {
      error: {
        code: n.code,
        message: n.message,
        ...(n.details !== undefined ? { details: toJsonSafe(n.details) } : {}),
        ...(requestId ? { requestId } : {}),
      },
    };
    res.status(n.status).json(body);
  }
}
