import { ErrorCode } from '@app/shared';

/**
 * The one exception type services should throw for expected failures. The global exception filter
 * renders it as `{ error: { code, message, details, requestId } }` with `httpStatus`.
 *
 * `message` is shown to end users — keep it human-friendly and free of internals.
 * `details` must be JSON-safe (bigint is converted) and must never contain secrets.
 */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly httpStatus: number = defaultStatusFor(code),
    readonly details?: unknown,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AppError';
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

const DEFAULT_STATUS: Partial<Record<ErrorCode, number>> = {
  [ErrorCode.ValidationFailed]: 400,
  [ErrorCode.PolicyInvalid]: 400,
  [ErrorCode.ReferralCodeInvalid]: 400,
  [ErrorCode.OtpInvalid]: 400,
  [ErrorCode.OtpExpired]: 400,
  [ErrorCode.Unauthenticated]: 401,
  [ErrorCode.InvalidCredentials]: 401,
  [ErrorCode.MfaRequired]: 403,
  [ErrorCode.Forbidden]: 403,
  [ErrorCode.CsrfFailed]: 403,
  [ErrorCode.AccountSuspended]: 403,
  [ErrorCode.EmailNotVerified]: 403,
  [ErrorCode.NotFound]: 404,
  [ErrorCode.Conflict]: 409,
  [ErrorCode.InvariantViolation]: 409,
  [ErrorCode.ReferralCycle]: 409,
  [ErrorCode.ProgramNotEnrollable]: 409,
  [ErrorCode.AlreadyEnrolled]: 409,
  [ErrorCode.NotEligible]: 409,
  [ErrorCode.InvalidStateTransition]: 409,
  [ErrorCode.StaleVersion]: 409,
  [ErrorCode.IdempotencyConflict]: 409,
  [ErrorCode.PayloadTooLarge]: 413,
  [ErrorCode.AccountLocked]: 423,
  [ErrorCode.OtpTooManyAttempts]: 429,
  [ErrorCode.OtpCooldown]: 429,
  [ErrorCode.RateLimited]: 429,
  [ErrorCode.Internal]: 500,
  [ErrorCode.NotImplemented]: 501,
  [ErrorCode.ServiceUnavailable]: 503,
};

export function defaultStatusFor(code: ErrorCode): number {
  return DEFAULT_STATUS[code] ?? 400;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export const validationFailed = (message = 'The request is invalid', details?: unknown) =>
  new AppError(ErrorCode.ValidationFailed, message, 400, details);

export const unauthenticated = (message = 'Please sign in to continue') =>
  new AppError(ErrorCode.Unauthenticated, message, 401);

export const forbidden = (message = 'You do not have permission to perform this action', details?: unknown) =>
  new AppError(ErrorCode.Forbidden, message, 403, details);

/** `details.reason`: MfaRequiredReason (TOTP_ENROLLMENT_REQUIRED | TOTP_REQUIRED) on admin routes. */
export const mfaRequired = (message = 'Complete the verification step to access the admin area', details?: unknown) =>
  new AppError(ErrorCode.MfaRequired, message, 403, details);

/** `notFound('Program')` → "Program not found". */
export const notFound = (resource = 'Resource', details?: unknown) =>
  new AppError(ErrorCode.NotFound, `${resource} not found`, 404, details);

export const conflict = (message = 'The request conflicts with the current state', details?: unknown) =>
  new AppError(ErrorCode.Conflict, message, 409, details);

/** Domain state machine violations, e.g. `invalidState('Only DRAFT programs can be deleted', { status })`. */
export const invalidState = (message: string, details?: unknown) =>
  new AppError(ErrorCode.InvalidStateTransition, message, 409, details);

export const staleVersion = (message = 'This record was changed by someone else. Reload and try again') =>
  new AppError(ErrorCode.StaleVersion, message, 409);

export const invariantViolation = (message = 'The change violates a data integrity rule', details?: unknown) =>
  new AppError(ErrorCode.InvariantViolation, message, 409, details);

export const rateLimited = (message = 'Too many requests. Please try again later', details?: unknown) =>
  new AppError(ErrorCode.RateLimited, message, 429, details);

export const csrfFailed = (message = 'Security check failed. Refresh the page and try again') =>
  new AppError(ErrorCode.CsrfFailed, message, 403);

export const serviceUnavailable = (message = 'Service temporarily unavailable', details?: unknown) =>
  new AppError(ErrorCode.ServiceUnavailable, message, 503, details);

/** Generic failure with an explicit code (status from the code's default mapping). */
export const appError = (code: ErrorCode, message: string, details?: unknown) =>
  new AppError(code, message, defaultStatusFor(code), details);
