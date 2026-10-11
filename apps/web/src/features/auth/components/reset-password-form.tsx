'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import {
  OTP_RESEND_COOLDOWN_SECONDS,
  resetPasswordSchema,
  type ResetPasswordInput,
  type ResetPasswordRequest,
} from '@app/shared';

import { AuthHeading } from '@/components/app/auth-heading';
import { applyApiFieldErrors, FormTextField } from '@/components/app/form';
import { FieldGroup } from '@/components/ui/field';
import { routes } from '@/config/routes';
import { isApiError } from '@/lib/api-client';

import { useForgotPassword, useResetPassword } from '../api';
import { forgetPendingEmail, readPendingEmail } from '../lib/navigation';
import { useResetWhenHidden } from '../lib/use-reset-when-hidden';
import { FormErrorAlert, InfoAlert, ResendButton, SubmitButton } from './auth-bits';
import { FormOtpField, FormPasswordField, NEW_PASSWORD_HINT } from './form-fields';

/**
 * Code from the email + a new password. Every signed-in device is signed out afterwards. Also where
 * admin-role accounts finish a reset a Super Admin sent them (they cannot request codes here).
 */
export function ResetPasswordForm() {
  const router = useRouter();
  const reset = useResetPassword();
  const resend = useForgotPassword();
  const [resendAt, setResendAt] = useState<number | null>(null);

  const form = useForm<ResetPasswordInput, unknown, ResetPasswordRequest>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { email: '', code: '', newPassword: '' },
  });
  // After a success the screen stays mounted while hidden: never return to a disabled button, an old
  // error or a typed password.
  useResetWhenHidden(() => {
    reset.reset();
    resend.reset();
    form.reset();
  });

  useEffect(() => {
    const pending = readPendingEmail();
    if (pending) form.setValue('email', pending);
  }, [form]);

  const onSubmit = form.handleSubmit((values) =>
    reset.mutate(values, {
      onSuccess: () => {
        forgetPendingEmail();
        toast.success('Password updated', { description: 'Sign in with your new password.' });
        router.replace(`${routes.auth.login}?reset=1`);
      },
      onError: (error) => {
        applyApiFieldErrors(error, form.setError, {
          knownFields: ['email', 'code', 'newPassword'],
        });
        form.setValue('code', '');
      },
    }),
  );

  const onResend = async () => {
    if (!(await form.trigger('email'))) return;
    resend.mutate(
      { email: form.getValues('email').trim().toLowerCase() },
      { onSuccess: (res) => setResendAt(Date.now() + res.resendAfterSeconds * 1000) },
    );
  };

  return (
    <>
      <AuthHeading
        title="Choose a new password"
        description="Enter the code from the email and your new password."
      />
      <div className="space-y-4">
        {reset.isError && !(isApiError(reset.error) && reset.error.hasFieldErrors) ? (
          <FormErrorAlert error={reset.error} />
        ) : null}
        {resend.isSuccess && !reset.isError ? <InfoAlert>{resend.data.message}</InfoAlert> : null}
        {resend.isError ? <FormErrorAlert error={resend.error} /> : null}
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <FormTextField
              control={form.control}
              name="email"
              label="Email"
              type="email"
              autoComplete="email"
              inputMode="email"
              required
            />
            <FormOtpField control={form.control} name="code" label="Code" autoFocus required />
            <FormPasswordField
              control={form.control}
              name="newPassword"
              label="New password"
              autoComplete="new-password"
              description={NEW_PASSWORD_HINT}
              required
            />
            <SubmitButton pending={reset.isPending || reset.isSuccess}>
              Update password
            </SubmitButton>
          </FieldGroup>
        </form>
        <div className="flex flex-col items-center gap-1 text-sm text-muted-foreground">
          <ResendButton
            availableAt={resendAt}
            initialCooldownSeconds={OTP_RESEND_COOLDOWN_SECONDS}
            onResend={() => void onResend()}
            pending={resend.isPending}
            label="Send a new code"
          />
          <span className="text-center text-xs">
            Administrator accounts can&apos;t request codes themselves — if yours expired, ask a
            Super Admin to send a new one.
          </span>
          <Link
            href={routes.auth.login}
            className="text-primary underline-offset-4 hover:underline"
          >
            Back to sign in
          </Link>
        </div>
      </div>
    </>
  );
}
