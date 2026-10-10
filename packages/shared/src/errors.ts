// Stable, machine-readable error codes returned in `{ error: { code } }`.

export const ErrorCode = {
  ValidationFailed: 'VALIDATION_FAILED',
  Unauthenticated: 'UNAUTHENTICATED',
  MfaRequired: 'MFA_REQUIRED',
  Forbidden: 'FORBIDDEN',
  NotFound: 'NOT_FOUND',
  Conflict: 'CONFLICT',
  InvariantViolation: 'INVARIANT_VIOLATION',
  RateLimited: 'RATE_LIMITED',
  CsrfFailed: 'CSRF_FAILED',
  InvalidCredentials: 'INVALID_CREDENTIALS',
  AccountLocked: 'ACCOUNT_LOCKED',
  AccountSuspended: 'ACCOUNT_SUSPENDED',
  EmailNotVerified: 'EMAIL_NOT_VERIFIED',
  OtpInvalid: 'OTP_INVALID',
  OtpExpired: 'OTP_EXPIRED',
  OtpTooManyAttempts: 'OTP_TOO_MANY_ATTEMPTS',
  OtpCooldown: 'OTP_COOLDOWN',
  ReferralCodeInvalid: 'REFERRAL_CODE_INVALID',
  ReferralCycle: 'REFERRAL_CYCLE',
  ProgramNotEnrollable: 'PROGRAM_NOT_ENROLLABLE',
  AlreadyEnrolled: 'ALREADY_ENROLLED',
  NotEligible: 'NOT_ELIGIBLE',
  InvalidStateTransition: 'INVALID_STATE_TRANSITION',
  PolicyInvalid: 'POLICY_INVALID',
  StaleVersion: 'STALE_VERSION',
  IdempotencyConflict: 'IDEMPOTENCY_CONFLICT',
  PayloadTooLarge: 'PAYLOAD_TOO_LARGE',
  NotImplemented: 'NOT_IMPLEMENTED',
  ServiceUnavailable: 'SERVICE_UNAVAILABLE',
  Internal: 'INTERNAL_ERROR',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * `details.reason` of a 403 MFA_REQUIRED on /api/v1/admin/*:
 * - TOTP_ENROLLMENT_REQUIRED: the admin has no confirmed TOTP factor yet (enroll one first);
 * - TOTP_REQUIRED: a TOTP code must be verified in this session (or the last one is older than 12 h).
 */
export const MfaRequiredReason = {
  TotpEnrollmentRequired: 'TOTP_ENROLLMENT_REQUIRED',
  TotpRequired: 'TOTP_REQUIRED',
} as const;
export type MfaRequiredReason = (typeof MfaRequiredReason)[keyof typeof MfaRequiredReason];

export interface ApiErrorBody {
  error: {
    code: ErrorCode | string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}
