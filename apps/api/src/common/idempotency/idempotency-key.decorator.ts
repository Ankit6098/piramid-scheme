import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { validationFailed } from '../errors/app-error';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
const KEY_RE = /^[A-Za-z0-9_\-:.]{8,128}$/;

export interface IdempotencyKeyOptions {
  /** Missing header → 400 VALIDATION_FAILED. Default false (returns undefined). */
  required?: boolean;
}

/** Pure parser (unit-tested): validates 8..128 chars of [A-Za-z0-9_-:.]. */
export function parseIdempotencyKey(raw: string | string[] | undefined, required = false): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === '') {
    if (required) {
      throw validationFailed('The Idempotency-Key header is required', {
        issues: [{ path: 'headers.idempotency-key', message: 'Required', code: 'invalid_type' }],
      });
    }
    return undefined;
  }
  if (!KEY_RE.test(value)) {
    throw validationFailed('The Idempotency-Key header is invalid', {
      issues: [
        {
          path: 'headers.idempotency-key',
          message: 'Must be 8–128 characters of letters, digits, "-", "_", ":" or "."',
          code: 'invalid_format',
        },
      ],
    });
  }
  return value;
}

/**
 * Reads the `Idempotency-Key` header.
 * @example approve(@IdempotencyKey({ required: true }) key: string) { ... }
 * Scope the key per actor + operation before storing/using it, e.g. `reward-approve:${userId}:${key}`.
 */
export const IdempotencyKey = createParamDecorator(
  (options: IdempotencyKeyOptions | undefined, ctx: ExecutionContext): string | undefined => {
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    return parseIdempotencyKey(req.headers[IDEMPOTENCY_HEADER], options?.required ?? false);
  },
);
