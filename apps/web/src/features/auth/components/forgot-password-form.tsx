'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { forgotPasswordSchema, type ForgotPasswordRequest } from '@app/shared';

import { AuthHeading } from '@/components/app/auth-heading';
import { applyApiFieldErrors, FormTextField } from '@/components/app/form';
import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field';
import { routes } from '@/config/routes';

import { useForgotPassword } from '../api';
import { rememberPendingEmail } from '../lib/navigation';
import { useResetWhenHidden } from '../lib/use-reset-when-hidden';
import { FormErrorAlert, InfoAlert, SubmitButton } from './auth-bits';

/** Requests a password-reset code. The answer never reveals whether the address has an account. */
export function ForgotPasswordForm() {
  const router = useRouter();
  const forgot = useForgotPassword();
  const form = useForm<z.input<typeof forgotPasswordSchema>, unknown, ForgotPasswordRequest>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  });
  // Coming back to this screen starts a new request instead of showing the old "Check your email".
  useResetWhenHidden(() => {
    forgot.reset();
    form.reset();
  });

  const onSubmit = form.handleSubmit((values) =>
    forgot.mutate(values, {
      onSuccess: () => rememberPendingEmail(values.email),
      onError: (error) => applyApiFieldErrors(error, form.setError, { knownFields: ['email'] }),
    }),
  );

  if (forgot.isSuccess) {
    return (
      <>
        <AuthHeading title="Check your email" />
        <div className="space-y-4">
          <InfoAlert>{forgot.data.message}</InfoAlert>
          <p className="text-sm text-muted-foreground">
            The code expires in 10 minutes. Administrators can&apos;t reset their password
            themselves — ask a Super Admin instead.
          </p>
          <Button className="w-full" onClick={() => router.push(routes.auth.resetPassword)}>
            Enter the code
          </Button>
          <p className="text-center text-sm">
            <Link
              href={routes.auth.login}
              className="text-primary underline-offset-4 hover:underline"
            >
              Back to sign in
            </Link>
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <AuthHeading
        title="Reset your password"
        description="Enter your account email and we'll send you a 6-digit code."
      />
      <div className="space-y-4">
        {forgot.isError && !form.formState.errors.email ? (
          <FormErrorAlert error={forgot.error} />
        ) : null}
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <FormTextField
              control={form.control}
              name="email"
              label="Email"
              type="email"
              autoComplete="email"
              inputMode="email"
              autoFocus
              required
            />
            <SubmitButton pending={forgot.isPending}>Send code</SubmitButton>
          </FieldGroup>
        </form>
        <p className="text-center text-sm">
          <Link
            href={routes.auth.login}
            className="text-primary underline-offset-4 hover:underline"
          >
            Back to sign in
          </Link>
        </p>
      </div>
    </>
  );
}
