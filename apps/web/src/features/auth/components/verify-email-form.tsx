'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  ErrorCode,
  OTP_RESEND_COOLDOWN_SECONDS,
  verifyEmailSchema,
  type SessionUserDto,
  type VerifyEmailInput,
  type VerifyEmailRequest,
} from '@app/shared';

import { AuthHeading } from '@/components/app/auth-heading';
import { applyApiFieldErrors, FormTextField } from '@/components/app/form';
import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field';
import { routes } from '@/config/routes';
import { isApiError } from '@/lib/api-client';

import { useResendVerification, useVerifyEmail } from '../api';
import {
  destinationAfterAuth,
  forgetPendingEmail,
  hardNavigate,
  readPendingEmail,
} from '../lib/navigation';
import { useResetWhenHidden } from '../lib/use-reset-when-hidden';
import { FormErrorAlert, InfoAlert, ResendButton, SubmitButton } from './auth-bits';
import { FormOtpField, FormPasswordField } from './form-fields';

/**
 * Step 2 of registration: the 6-digit code from the email plus the password chosen at registration
 * create the account (and link the sponsor, if a valid referral code was given) and sign the member
 * in. The password is required so a code from somebody else's registration for this address can
 * never activate an account with their password. Only the email is carried over from the register
 * screen (sessionStorage); the password lives in form state only.
 */
export function VerifyEmailForm() {
  const queryClient = useQueryClient();
  const verify = useVerifyEmail();
  const resend = useResendVerification();
  const [resendAt, setResendAt] = useState<number | null>(null);
  const [resent, setResent] = useState(false);
  const [joinedWithoutSponsor, setJoinedWithoutSponsor] = useState<SessionUserDto | null>(null);

  const form = useForm<VerifyEmailInput, unknown, VerifyEmailRequest>({
    resolver: zodResolver(verifyEmailSchema),
    defaultValues: { email: '', code: '', password: '' },
  });
  // Hidden screens keep their state: clear old errors, "code resent" notices, the code and password.
  useResetWhenHidden(() => {
    verify.reset();
    resend.reset();
    setResent(false);
    setJoinedWithoutSponsor(null);
    form.reset();
  });

  useEffect(() => {
    const pending = readPendingEmail();
    if (pending) form.setValue('email', pending);
  }, [form]);

  const finish = (user: SessionUserDto) => {
    forgetPendingEmail();
    hardNavigate(queryClient, destinationAfterAuth(user, null));
  };

  const onSubmit = form.handleSubmit((values) =>
    verify.mutate(values, {
      onSuccess: (result) => {
        if (result.referral.codeNoLongerValid) setJoinedWithoutSponsor(result.user);
        else finish(result.user);
      },
      onError: (error) => {
        applyApiFieldErrors(error, form.setError, { knownFields: ['email', 'code', 'password'] });
        form.setValue('code', '');
      },
    }),
  );

  const onResend = async () => {
    const valid = await form.trigger('email');
    if (!valid) return;
    resend.mutate(
      { email: form.getValues('email').trim().toLowerCase() },
      {
        onSuccess: (res) => {
          setResent(true);
          setResendAt(Date.now() + res.resendAfterSeconds * 1000);
        },
      },
    );
  };

  if (joinedWithoutSponsor) {
    return (
      <>
        <AuthHeading title="Your account is ready" />
        <div className="space-y-4">
          <InfoAlert title="Referral code not applied">
            The referral code you entered is no longer active, so your account was created without a
            sponsor. You can still use every feature of the platform.
          </InfoAlert>
          <Button className="w-full" onClick={() => finish(joinedWithoutSponsor)}>
            <CircleCheck aria-hidden />
            Continue to your dashboard
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <AuthHeading
        title="Check your email"
        description="Enter the 6-digit code we sent to your address and confirm your password. The code expires in 10 minutes."
      />
      <div className="space-y-4">
        {verify.isError && !form.formState.errors.email ? (
          <FormErrorAlert error={verify.error} />
        ) : null}
        {verify.isError &&
        isApiError(verify.error) &&
        verify.error.code === ErrorCode.OtpInvalid ? (
          <p className="text-sm text-muted-foreground">
            Use the code from the latest email and the password you chose when you registered. If
            you didn&apos;t start this registration or don&apos;t remember that password,{' '}
            <Link
              href={routes.auth.register}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              register again
            </Link>
            .
          </p>
        ) : null}
        {resent && !verify.isError ? (
          <InfoAlert>
            If a registration is waiting for this address, a new code is on its way.
          </InfoAlert>
        ) : null}
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
            <FormOtpField
              control={form.control}
              name="code"
              label="Verification code"
              autoFocus
              required
              onComplete={() => {
                if (verify.isPending) return;
                // Submit once the password is filled in; otherwise continue with the password.
                if (form.getValues('password')) void onSubmit();
                else form.setFocus('password');
              }}
            />
            <FormPasswordField
              control={form.control}
              name="password"
              label="Confirm your password"
              autoComplete="current-password"
              description="The password you chose when you registered."
              required
            />
            <SubmitButton pending={verify.isPending || verify.isSuccess}>
              Verify and continue
            </SubmitButton>
          </FieldGroup>
        </form>
        <div className="flex flex-col items-center gap-1 text-sm text-muted-foreground">
          <span>Didn&apos;t get it? Check your spam folder, or</span>
          <ResendButton
            availableAt={resendAt}
            initialCooldownSeconds={OTP_RESEND_COOLDOWN_SECONDS}
            onResend={() => void onResend()}
            pending={resend.isPending}
          />
        </div>
        <p className="text-center text-sm text-muted-foreground">
          Wrong address?{' '}
          <Link
            href={routes.auth.register}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Register again
          </Link>
        </p>
      </div>
    </>
  );
}
