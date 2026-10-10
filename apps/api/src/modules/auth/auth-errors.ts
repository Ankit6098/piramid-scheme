import { ErrorCode, OTP_RESEND_COOLDOWN_SECONDS, OTP_TTL_SECONDS, type AcceptedResponseDto } from '@app/shared';
import { AppError } from '../../common/errors/app-error';
import type { OtpSendDecision } from './domain/otp-policy';

/** Unknown email and wrong password look exactly the same (business rules §2). */
export const invalidCredentials = () => new AppError(ErrorCode.InvalidCredentials, 'Incorrect email or password', 401);

/**
 * Every failed email-code verification (wrong, expired, used, too many attempts, blocked, no code at
 * all) gets this one response so it reveals nothing about the address.
 */
export const otpInvalid = () =>
  new AppError(ErrorCode.OtpInvalid, 'That code is incorrect or has expired. Check the latest email or request a new code', 400);

export const totpInvalid = () =>
  new AppError(ErrorCode.OtpInvalid, 'That code is incorrect. Check your authenticator app and try again', 400);

/** Authenticated flows (admin email MFA) may say why a new code cannot be sent yet. */
export function otpSendRefused(decision: Extract<OtpSendDecision, { allowed: false }>): AppError {
  const details = { retryAfterSeconds: decision.retryAfterSeconds };
  switch (decision.reason) {
    case 'COOLDOWN':
      return new AppError(ErrorCode.OtpCooldown, 'Please wait a moment before requesting another code', 429, details);
    case 'HOURLY_CAP':
      return new AppError(ErrorCode.RateLimited, 'Too many codes were requested. Please try again later', 429, details);
    case 'BLOCKED':
      return new AppError(ErrorCode.OtpTooManyAttempts, 'Too many incorrect codes. New codes are paused for 24 hours', 429, details);
  }
}

/** The identical 202 body of register / resend / forgot-password / email-change starts. */
export function accepted(message: string): AcceptedResponseDto {
  return {
    accepted: true,
    message,
    expiresInSeconds: OTP_TTL_SECONDS,
    resendAfterSeconds: OTP_RESEND_COOLDOWN_SECONDS,
  };
}

export const ACCEPTED_MESSAGES = {
  register: 'Check your inbox. If this address can be used for a new account, we sent it a 6-digit verification code.',
  resend: 'If a registration is waiting for this address, a new code is on its way.',
  forgot: 'If an account can reset its password with this address, we sent it a 6-digit code.',
  emailChange: 'If the new address can be used, we sent it a 6-digit confirmation code.',
} as const;
