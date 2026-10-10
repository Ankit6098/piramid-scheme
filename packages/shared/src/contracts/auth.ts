// Contracts (Zod request schemas + response types) for the auth module.
// Owned by the auth module implementer; keep request schemas and response DTO types together.
// Business rules: docs/business-rules.md §2.

import { z } from 'zod';

import type { MfaMethod } from '../enums';
import type { Permission, RoleKey } from '../permissions';

// ─── Policy constants (mirrored by the API; the UI uses them for hints and countdowns) ───────────

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;
export const OTP_CODE_LENGTH = 6;
/** One-time codes expire after 10 minutes. */
export const OTP_TTL_SECONDS = 600;
/** A new code for the same address and purpose can be requested after 60 seconds. */
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

// ─── Field schemas ─────────────────────────────────────────────────────────────────────────

/** Trimmed + lower-cased email (the API stores and compares the normalized form). */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Enter your email address')
  .max(254, 'Email addresses can be at most 254 characters')
  .pipe(z.email('Enter a valid email address'));

/** New passwords: ≥ 10 characters with at least one letter and one digit (stored as argon2id). */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters`)
  .regex(/\p{L}/u, 'Include at least one letter')
  .regex(/\p{Nd}/u, 'Include at least one digit');

/** An existing password typed to authenticate (no strength rules — those only apply to new ones). */
export const currentPasswordSchema = z
  .string()
  .min(1, 'Enter your password')
  .max(256, 'Password is too long');

/** Display name: 2–120 characters, no control characters. */
export const fullNameSchema = z
  .string()
  .trim()
  .min(2, 'Enter your full name')
  .max(120, 'Use at most 120 characters')
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f\u007f]+$/, 'Remove special control characters');

/** 6-digit one-time code (email OTP or authenticator app). Spaces are ignored. */
export const otpCodeSchema = z
  .string()
  .transform((v) => v.replace(/\s+/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'));

/** Optional referral code typed or taken from `?ref=`. Empty → undefined. */
export const optionalReferralCodeSchema = z
  .string()
  .trim()
  .max(32, 'Referral codes are at most 32 characters')
  .optional()
  .transform((v) => (v ? v : undefined));

// ─── Requests ──────────────────────────────────────────────────────────────────────────────

/** `POST /auth/register` — never creates the account; a code is emailed (generic 202). */
export const registerSchema = z.object({
  fullName: fullNameSchema,
  email: emailSchema,
  password: passwordSchema,
  referralCode: optionalReferralCodeSchema,
});
export type RegisterInput = z.input<typeof registerSchema>;
export type RegisterRequest = z.output<typeof registerSchema>;

/** `POST /auth/register/resend` (generic 202). */
export const resendVerificationSchema = z.object({ email: emailSchema });
export type ResendVerificationRequest = z.output<typeof resendVerificationSchema>;

/** `POST /auth/verify-email` — creates the account, attaches the sponsor, signs in. */
export const verifyEmailSchema = z.object({ email: emailSchema, code: otpCodeSchema });
export type VerifyEmailInput = z.input<typeof verifyEmailSchema>;
export type VerifyEmailRequest = z.output<typeof verifyEmailSchema>;

/** `POST /auth/login`. */
export const loginSchema = z.object({ email: emailSchema, password: currentPasswordSchema });
export type LoginInput = z.input<typeof loginSchema>;
export type LoginRequest = z.output<typeof loginSchema>;

/** `POST /auth/mfa/email/verify`, `/auth/mfa/totp/confirm`, `/auth/mfa/totp/verify`. */
export const mfaCodeSchema = z.object({ code: otpCodeSchema });
export type MfaCodeInput = z.input<typeof mfaCodeSchema>;
export type MfaCodeRequest = z.output<typeof mfaCodeSchema>;

/** `POST /auth/password/forgot` (generic 202). */
export const forgotPasswordSchema = z.object({ email: emailSchema });
export type ForgotPasswordRequest = z.output<typeof forgotPasswordSchema>;

/** `POST /auth/password/reset` — revokes every session of the account. */
export const resetPasswordSchema = z.object({
  email: emailSchema,
  code: otpCodeSchema,
  newPassword: passwordSchema,
});
export type ResetPasswordInput = z.input<typeof resetPasswordSchema>;
export type ResetPasswordRequest = z.output<typeof resetPasswordSchema>;

// ─── Responses ─────────────────────────────────────────────────────────────────────────────

/**
 * `GET /auth/session` → `{ data: { user } }` (401 when signed out). Roles/permissions are loaded per
 * request; `adminAccess` = admin role AND a TOTP verification in this session within 12 h.
 */
export interface SessionUserDto {
  id: string;
  fullName: string;
  email: string;
  emailVerified: boolean;
  avatarUrl: string | null;
  roles: RoleKey[];
  permissions: Permission[];
  /** Holds at least one non-MEMBER role. */
  isAdmin: boolean;
  /** May use the admin area (`/api/v1/admin/*`) with this session. */
  adminAccess: boolean;
  /** Second factor completed in THIS session (null = none). */
  mfaMethod: MfaMethod | null;
  /** A confirmed authenticator app (TOTP) is enrolled. */
  hasTotpFactor: boolean;
}

export interface SessionResponseDto {
  user: SessionUserDto;
}

/** Second step an admin login needs: verify the authenticator, or enroll one (email code first). */
export const AdminMfaStep = ['TOTP', 'TOTP_ENROLLMENT'] as const;
export type AdminMfaStep = (typeof AdminMfaStep)[number];

/** `POST /auth/login` → a session is created in both cases; admins must complete MFA for /admin. */
export type LoginResponseDto =
  | { mfaRequired: false; user: SessionUserDto }
  | { mfaRequired: true; method: AdminMfaStep; user: SessionUserDto };

/**
 * Generic `202 Accepted` body of register / resend / forgot-password / email-change starts. It is
 * identical whether or not the address has an account (no enumeration).
 */
export interface AcceptedResponseDto {
  accepted: true;
  message: string;
  /** Codes expire after this many seconds. */
  expiresInSeconds: number;
  /** The UI may offer "resend" after this many seconds. */
  resendAfterSeconds: number;
}

/** `POST /auth/verify-email`. */
export interface VerifyEmailResponseDto {
  user: SessionUserDto;
  referral: {
    /** A sponsor was attached from the referral code. */
    applied: boolean;
    /** A code was given at registration but was no longer valid at verification (joined without a sponsor). */
    codeNoLongerValid: boolean;
  };
}

/** `POST /auth/mfa/email/send`. */
export interface MfaEmailSentResponseDto {
  /** Masked destination, e.g. `a***@e***.com`. */
  sentTo: string;
  expiresAt: string;
  resendAfterSeconds: number;
}

/** `POST /auth/mfa/totp/setup` — the secret is shown ONCE; it is stored encrypted. */
export interface TotpSetupResponseDto {
  otpauthUri: string;
  /** Base32 secret for manual entry. */
  secret: string;
  issuer: string;
  accountName: string;
}

/** `POST /auth/mfa/email/verify`, `/auth/mfa/totp/confirm`, `/auth/mfa/totp/verify`. */
export interface MfaVerifiedResponseDto {
  user: SessionUserDto;
}

/** `POST /auth/password/reset`. */
export interface PasswordResetResponseDto {
  passwordReset: true;
}

/** `POST /auth/logout`. */
export interface LogoutResponseDto {
  signedOut: true;
}
