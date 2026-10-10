'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import {
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

import { useResendVerification, useVerifyEmail } from '../api';
import {
  destinationAfterAuth,
  forgetPendingEmail,
  hardNavigate,
  readPendingEmail,
} from '../lib/navigation';
import { FormErrorAlert, InfoAlert, ResendButton, SubmitButton } from './auth-bits';
import { FormOtpField } from './form-fields';

/**
 * Step 2 of registration: the 6-digit code from the email creates the account (and links the
 * sponsor, if a valid referral code was given) and signs the member in.
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
    defaultValues: { email: '', code: '' },
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
        applyApiFieldErrors(error, form.setError, { knownFields: ['email', 'code'] });
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
        description="Enter the 6-digit code we sent to your address. It expires in 10 minutes."
      />
      <div className="space-y-4">
        {verify.isError && !form.formState.errors.email ? (
          <FormErrorAlert error={verify.error} />
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
                if (!verify.isPending) void onSubmit();
              }}
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
