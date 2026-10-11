'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { CircleCheck, KeyRound, Mail, ShieldAlert, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import {
  changePasswordSchema,
  confirmEmailChangeSchema,
  resetTotpSchema,
  startEmailChangeSchema,
  type ChangePasswordInput,
  type ChangePasswordRequest,
  type ConfirmEmailChangeInput,
  type ConfirmEmailChangeRequest,
  type ProfileDto,
  type ResetTotpInput,
  type ResetTotpRequest,
  type StartEmailChangeInput,
  type StartEmailChangeRequest,
} from '@app/shared';

import { DateTime } from '@/components/app/date-time';
import { applyApiFieldErrors, FormTextField } from '@/components/app/form';
import { ToneBadge } from '@/components/app/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldGroup } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { mfaHref, routes } from '@/config/routes';
import { FormErrorAlert, InfoAlert, ResendButton } from '@/features/auth/components/auth-bits';
import { MfaNotice, mfaNoticeHref } from '@/features/auth/lib/navigation';
import {
  FormOtpField,
  FormPasswordField,
  NEW_PASSWORD_HINT,
} from '@/features/auth/components/form-fields';
import { getErrorMessage, isApiError } from '@/lib/api-client';

import {
  useChangePassword,
  useConfirmEmailChange,
  useResetTotp,
  useStartEmailChange,
} from '../api';

const showAlert = (error: unknown) =>
  Boolean(error) && !(isApiError(error) && error.hasFieldErrors);

// ─── Password ────────────────────────────────────────────────────────────────

export function PasswordCard({ profile }: { profile: ProfileDto }) {
  const change = useChangePassword();
  const form = useForm<ChangePasswordInput, unknown, ChangePasswordRequest>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: '', newPassword: '' },
  });

  const onSubmit = form.handleSubmit((values) =>
    change.mutate(values, {
      onSuccess: () => {
        form.reset();
        toast.success('Password changed', { description: 'Your other devices were signed out.' });
      },
      onError: (error) =>
        applyApiFieldErrors(error, form.setError, {
          knownFields: ['currentPassword', 'newPassword'],
        }),
    }),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4 text-muted-foreground" aria-hidden />
          Password
        </CardTitle>
        <CardDescription>
          {profile.passwordChangedAt ? (
            <>
              Last changed <DateTime value={profile.passwordChangedAt} style="date" />.{' '}
            </>
          ) : null}
          Changing it signs out all your other devices.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          {showAlert(change.error) ? <FormErrorAlert error={change.error} /> : null}
          <FieldGroup>
            <FormPasswordField
              control={form.control}
              name="currentPassword"
              label="Current password"
              autoComplete="current-password"
              required
            />
            <FormPasswordField
              control={form.control}
              name="newPassword"
              label="New password"
              autoComplete="new-password"
              description={NEW_PASSWORD_HINT}
              required
            />
          </FieldGroup>
          <div className="flex justify-end">
            <Button type="submit" disabled={change.isPending}>
              {change.isPending ? <Spinner /> : null}
              Change password
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ─── Email ───────────────────────────────────────────────────────────────────

export function EmailCard({ profile }: { profile: ProfileDto }) {
  const start = useStartEmailChange();
  const confirm = useConfirmEmailChange();
  const [pending, setPending] = useState<{ email: string; resendAt: number } | null>(null);

  const startForm = useForm<StartEmailChangeInput, unknown, StartEmailChangeRequest>({
    resolver: zodResolver(startEmailChangeSchema),
    defaultValues: { newEmail: '', password: '' },
  });
  const codeForm = useForm<ConfirmEmailChangeInput, unknown, ConfirmEmailChangeRequest>({
    resolver: zodResolver(confirmEmailChangeSchema),
    defaultValues: { code: '' },
  });

  const send = (values: StartEmailChangeRequest, { resend = false } = {}) =>
    start.mutate(values, {
      onSuccess: (res) => {
        setPending({
          email: values.newEmail,
          resendAt: Date.now() + res.resendAfterSeconds * 1000,
        });
        codeForm.reset();
      },
      onError: (error) => {
        // A resend happens on the code screen, where the start fields are not shown: its errors
        // (e.g. "The password is incorrect", rate limits) are shown there as an alert instead.
        if (resend) return;
        applyApiFieldErrors(error, startForm.setError, { knownFields: ['newEmail', 'password'] });
      },
    });

  const onStart = startForm.handleSubmit((values) => send(values));
  const onConfirm = codeForm.handleSubmit((values) =>
    confirm.mutate(values, {
      onSuccess: (updated) => {
        setPending(null);
        startForm.reset();
        codeForm.reset();
        toast.success('Email address changed', {
          description: `You now sign in with ${updated.email}.`,
        });
      },
      onError: (error) => {
        applyApiFieldErrors(error, codeForm.setError, { knownFields: ['code'] });
        codeForm.setValue('code', '');
      },
    }),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="size-4 text-muted-foreground" aria-hidden />
          Email address
        </CardTitle>
        <CardDescription>
          You sign in with <span className="font-medium text-foreground">{profile.email}</span>. To
          change it, confirm your password and enter the code we send to the new address. Your
          current address is notified.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {pending ? (
          <form onSubmit={onConfirm} noValidate className="space-y-4">
            <InfoAlert title="Check the new inbox">
              If <span className="font-medium">{pending.email}</span> can be used, we sent it a
              6-digit code. It expires in 10 minutes.
            </InfoAlert>
            {start.isError ? (
              <FormErrorAlert error={start.error} title="We couldn't send a new code" />
            ) : null}
            {showAlert(confirm.error) ? <FormErrorAlert error={confirm.error} /> : null}
            <AdminStepUpHint error={confirm.error ?? start.error} />
            <FormOtpField
              control={codeForm.control}
              name="code"
              label="Confirmation code"
              autoFocus
              required
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <ResendButton
                availableAt={pending.resendAt}
                pending={start.isPending}
                onResend={() => {
                  const values = startForm.getValues();
                  send(
                    { newEmail: values.newEmail.trim().toLowerCase(), password: values.password },
                    { resend: true },
                  );
                }}
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    start.reset();
                    confirm.reset();
                    setPending(null);
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={confirm.isPending}>
                  {confirm.isPending ? <Spinner /> : null}
                  Confirm change
                </Button>
              </div>
            </div>
          </form>
        ) : (
          <form onSubmit={onStart} noValidate className="space-y-4">
            {showAlert(start.error) ? <FormErrorAlert error={start.error} /> : null}
            <AdminStepUpHint error={start.error} />
            <FieldGroup>
              <FormTextField
                control={startForm.control}
                name="newEmail"
                label="New email address"
                type="email"
                autoComplete="email"
                required
              />
              <FormPasswordField
                control={startForm.control}
                name="password"
                label="Current password"
                autoComplete="current-password"
                required
              />
            </FieldGroup>
            <div className="flex justify-end">
              <Button type="submit" disabled={start.isPending}>
                {start.isPending ? <Spinner /> : null}
                Send code
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Admin accounts change their sign-in email only from a session verified with the authenticator
 * app (the API answers MFA_REQUIRED otherwise) — offer the verification step.
 */
function AdminStepUpHint({ error }: { error: unknown }) {
  if (!isApiError(error) || !error.isMfaRequired) return null;
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={mfaHref(routes.member.profile)}>
        <ShieldAlert aria-hidden />
        Verify with your authenticator
      </Link>
    </Button>
  );
}

// ─── Two-step verification (admins) ──────────────────────────────────────────

export function TwoFactorCard({ profile }: { profile: ProfileDto }) {
  const reset = useResetTotp();
  const [resetting, setResetting] = useState(false);
  const form = useForm<ResetTotpInput, unknown, ResetTotpRequest>({
    resolver: zodResolver(resetTotpSchema),
    defaultValues: { code: '' },
  });

  const onReset = form.handleSubmit((values) =>
    reset.mutate(values.code, {
      onSuccess: () => {
        // A toast would not survive the full page load: the setup screen shows the confirmation.
        window.location.assign(mfaNoticeHref(routes.member.profile, MfaNotice.TotpRemoved));
      },
      onError: (error) => {
        if (!applyApiFieldErrors(error, form.setError, { knownFields: ['code'] })) {
          form.setError('code', { type: 'server', message: getErrorMessage(error) });
        }
        form.setValue('code', '');
      },
    }),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
          Two-step verification
        </CardTitle>
        <CardDescription>
          Admin access requires a code from an authenticator app on every new admin session.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {profile.hasTotpFactor ? (
          <div className="flex flex-wrap items-center gap-3">
            <ToneBadge tone="success">Authenticator enabled</ToneBadge>
            {profile.totpEnrolledAt ? (
              <span className="text-sm text-muted-foreground">
                Added <DateTime value={profile.totpEnrolledAt} style="date" />
              </span>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            <ToneBadge tone="warning">Not set up</ToneBadge>
            <p className="text-sm text-muted-foreground">
              You need an authenticator app before you can open the admin console.
            </p>
            <Button asChild>
              <Link href={mfaHref(routes.member.profile)}>
                <ShieldAlert aria-hidden />
                Set up authenticator
              </Link>
            </Button>
          </div>
        )}

        {profile.hasTotpFactor ? (
          resetting ? (
            <form onSubmit={onReset} noValidate className="space-y-4 rounded-lg border p-4">
              <p className="text-sm">
                Replacing your phone? Enter a current code from your authenticator to remove it.
                Your other sessions are signed out and Super Admins are notified. You will set up
                the new app right after.
              </p>
              <FormOtpField
                control={form.control}
                name="code"
                label="Current authenticator code"
                autoFocus
                required
              />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setResetting(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant="destructive" disabled={reset.isPending}>
                  {reset.isPending ? <Spinner /> : null}
                  Remove authenticator
                </Button>
              </div>
            </form>
          ) : (
            <Button variant="outline" onClick={() => setResetting(true)}>
              Replace authenticator app
            </Button>
          )
        ) : null}
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <CircleCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Lost your authenticator entirely? Ask a Super Admin to reset it — self-service password
          resets are disabled for admin accounts.
        </p>
      </CardContent>
    </Card>
  );
}
