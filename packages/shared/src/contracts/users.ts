// Contracts (Zod request schemas + response types) for the users module.
// Owned by the users module implementer; keep request schemas and response DTO types together.
// Self-service profile & security (`/users/me/*`). Business rules: docs/business-rules.md §2.

import { z } from 'zod';

import type { MfaMethod } from '../enums';
import type { RoleKey } from '../permissions';
import {
  currentPasswordSchema,
  emailSchema,
  fullNameSchema,
  otpCodeSchema,
  passwordSchema,
} from './auth';

// ─── Field schemas ─────────────────────────────────────────────────────────────────────────

/** Phone in international form; spaces, dashes, dots and brackets are removed (`+919876543210`). */
export const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s().-]/g, ''))
  .pipe(
    z
      .string()
      .regex(
        /^\+?[1-9]\d{6,14}$/,
        'Enter a valid phone number in international format, e.g. +919876543210',
      ),
  );

/** Absolute `https://` URL (avatars are loaded by browsers — no http, data: or javascript: URLs). */
export const httpsUrlSchema = z
  .string()
  .trim()
  .max(2048, 'URLs can be at most 2048 characters')
  .regex(/^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:[/?#][^\s]*)?$/, 'Use an https:// link');

// ─── Requests ──────────────────────────────────────────────────────────────────────────────

/** `PATCH /users/me` — send only the fields to change; `null` clears phone / avatar. */
export const updateProfileSchema = z
  .object({
    fullName: fullNameSchema.optional(),
    phone: phoneSchema.nullable().optional(),
    avatarUrl: httpsUrlSchema.nullable().optional(),
  })
  .refine((v) => v.fullName !== undefined || v.phone !== undefined || v.avatarUrl !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateProfileInput = z.input<typeof updateProfileSchema>;
export type UpdateProfileRequest = z.output<typeof updateProfileSchema>;

/** `POST /users/me/password` — revokes every other session. */
export const changePasswordSchema = z
  .object({ currentPassword: currentPasswordSchema, newPassword: passwordSchema })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: 'Choose a password different from the current one',
    path: ['newPassword'],
  });
export type ChangePasswordInput = z.input<typeof changePasswordSchema>;
export type ChangePasswordRequest = z.output<typeof changePasswordSchema>;

/** `POST /users/me/email-change` — generic 202; a code goes to the new address. */
export const startEmailChangeSchema = z.object({
  newEmail: emailSchema,
  password: currentPasswordSchema,
});
export type StartEmailChangeInput = z.input<typeof startEmailChangeSchema>;
export type StartEmailChangeRequest = z.output<typeof startEmailChangeSchema>;

/** `POST /users/me/email-change/confirm`. */
export const confirmEmailChangeSchema = z.object({ code: otpCodeSchema });
export type ConfirmEmailChangeInput = z.input<typeof confirmEmailChangeSchema>;
export type ConfirmEmailChangeRequest = z.output<typeof confirmEmailChangeSchema>;

/** `POST /users/me/mfa/totp/reset` — admins: current authenticator code required. */
export const resetTotpSchema = z.object({ code: otpCodeSchema });
export type ResetTotpInput = z.input<typeof resetTotpSchema>;
export type ResetTotpRequest = z.output<typeof resetTotpSchema>;

// ─── Responses ─────────────────────────────────────────────────────────────────────────────

/** `GET/PATCH /users/me` — the caller's own profile. */
export interface ProfileDto {
  id: string;
  fullName: string;
  email: string;
  emailVerifiedAt: string | null;
  phone: string | null;
  avatarUrl: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  passwordChangedAt: string | null;
  roles: RoleKey[];
  isAdmin: boolean;
  /** A confirmed authenticator app is enrolled. */
  hasTotpFactor: boolean;
  totpEnrolledAt: string | null;
  // NB: deliberately no "pending email change" field — it would reveal whether the requested
  // address is already taken (the start endpoint answers identically either way).
}

/** `GET /users/me/sessions` row (own sessions only). */
export interface UserSessionDto {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  mfaMethod: MfaMethod | null;
  /** The session making this request. */
  current: boolean;
}

/** `GET /users/me/activity` row — the caller's own audit trail (no other people's data). */
export interface ActivityEntryDto {
  id: string;
  /** Dotted audit action, e.g. `auth.login`, `user.password.change`. */
  action: string;
  resourceType: string;
  createdAt: string;
  /** Partially masked client IP (e.g. `203.0.113.x`). */
  ipAddress: string | null;
}

/** `POST /users/me/sessions/revoke-others`. */
export interface RevokeSessionsResponseDto {
  revoked: number;
}

/** `DELETE /users/me/sessions/:id`. */
export interface RevokeSessionResponseDto {
  revoked: true;
  /** The revoked session was the caller's own (they are now signed out). */
  current: boolean;
}
