'use client';

/**
 * Auth API calls (`/api/v1/auth/*`). Mutations only — the session itself is read with `useSession()`.
 * Request bodies are the parsed outputs of the shared Zod schemas (`@app/shared` contracts/auth).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  AcceptedResponseDto,
  ForgotPasswordRequest,
  LoginRequest,
  LoginResponseDto,
  MfaEmailSentResponseDto,
  MfaVerifiedResponseDto,
  PasswordResetResponseDto,
  RegisterRequest,
  ResendVerificationRequest,
  ResetPasswordRequest,
  TotpSetupResponseDto,
  ValidateReferralCodeResponse,
  VerifyEmailRequest,
  VerifyEmailResponseDto,
} from '@app/shared';

import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

export function useLogin() {
  return useMutation({
    mutationFn: (body: LoginRequest) => api.post<LoginResponseDto>('/auth/login', body),
  });
}

export function useRegister() {
  return useMutation({
    mutationFn: (body: RegisterRequest) => api.post<AcceptedResponseDto>('/auth/register', body),
  });
}

export function useResendVerification() {
  return useMutation({
    mutationFn: (body: ResendVerificationRequest) =>
      api.post<AcceptedResponseDto>('/auth/register/resend', body),
  });
}

export function useVerifyEmail() {
  return useMutation({
    mutationFn: (body: VerifyEmailRequest) =>
      api.post<VerifyEmailResponseDto>('/auth/verify-email', body),
  });
}

export function useForgotPassword() {
  return useMutation({
    mutationFn: (body: ForgotPasswordRequest) =>
      api.post<AcceptedResponseDto>('/auth/password/forgot', body),
  });
}

export function useResetPassword() {
  return useMutation({
    mutationFn: (body: ResetPasswordRequest) =>
      api.post<PasswordResetResponseDto>('/auth/password/reset', body),
  });
}

// ─── Admin MFA ───────────────────────────────────────────────────────────────

/**
 * Every successful MFA step rotates the session cookie and changes `mfaMethod`/`adminAccess`, so the
 * session query is refreshed afterwards.
 */
function useSessionRefresh() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.session.all });
}

export function useSendMfaEmailCode() {
  return useMutation({
    mutationFn: () => api.post<MfaEmailSentResponseDto>('/auth/mfa/email/send'),
  });
}

export function useVerifyMfaEmailCode() {
  const refresh = useSessionRefresh();
  return useMutation({
    mutationFn: (code: string) =>
      api.post<MfaVerifiedResponseDto>('/auth/mfa/email/verify', { code }),
    onSuccess: refresh,
  });
}

export function useStartTotpSetup() {
  return useMutation({
    mutationFn: () => api.post<TotpSetupResponseDto>('/auth/mfa/totp/setup'),
  });
}

export function useConfirmTotp() {
  return useMutation({
    mutationFn: (code: string) =>
      api.post<MfaVerifiedResponseDto>('/auth/mfa/totp/confirm', { code }),
  });
}

export function useVerifyTotp() {
  return useMutation({
    mutationFn: (code: string) =>
      api.post<MfaVerifiedResponseDto>('/auth/mfa/totp/verify', { code }),
  });
}

// ─── Referral code preview (referrals slice) ─────────────────────────────────

export interface ReferralPreview {
  valid: boolean;
  /** Privacy-safe sponsor name: first name + last initial. */
  sponsorDisplayName: string | null;
}

/**
 * Optional "Invited by …" preview via `POST /referrals/validate` (referrals slice; always 200 with
 * `{ valid, sponsorDisplayName? }`, strictly rate-limited). Any failure (rate limit, network, an older
 * API without the route) means "no preview" — the code is still validated authoritatively by
 * `POST /auth/register`.
 */
export async function previewReferralCode(
  code: string,
  signal?: AbortSignal,
): Promise<ReferralPreview | null> {
  try {
    const data = await api.post<ValidateReferralCodeResponse>(
      '/referrals/validate',
      { code },
      { signal },
    );
    const name = data.valid ? data.sponsorDisplayName?.trim() : undefined;
    return { valid: data.valid, sponsorDisplayName: name ? name : null };
  } catch {
    return null;
  }
}
