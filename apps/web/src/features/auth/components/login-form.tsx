'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { loginSchema, type LoginInput, type LoginRequest } from '@app/shared';

import { AuthHeading } from '@/components/app/auth-heading';
import { applyApiFieldErrors, FormTextField } from '@/components/app/form';
import { FieldGroup } from '@/components/ui/field';
import { isAdminPath, mfaHref, routes, safeNextPath } from '@/config/routes';

import { useLogin } from '../api';
import { destinationAfterAuth, hardNavigate } from '../lib/navigation';
import { FormErrorAlert, InfoAlert, SubmitButton } from './auth-bits';
import { FormPasswordField } from './form-fields';

/** Email + password sign-in. Admins continue to the second step (/mfa) unless they asked for a member page. */
export function LoginForm() {
  const searchParams = useSearchParams();
  const next = searchParams.get('next');
  const expired = searchParams.has('expired');
  const passwordReset = searchParams.get('reset') === '1';
  const queryClient = useQueryClient();
  const login = useLogin();

  const form = useForm<LoginInput, unknown, LoginRequest>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = form.handleSubmit((values) =>
    login.mutate(values, {
      onSuccess: (result) => {
        if (result.mfaRequired) {
          const safe = safeNextPath(next);
          const wantsMemberPage = safe !== null && !isAdminPath(safe.split(/[?#]/)[0] ?? '');
          hardNavigate(queryClient, wantsMemberPage ? safe : mfaHref(safe));
          return;
        }
        hardNavigate(queryClient, destinationAfterAuth(result.user, next));
      },
      onError: (error) => {
        applyApiFieldErrors(error, form.setError, { knownFields: ['email', 'password'] });
        form.resetField('password', { keepError: true });
      },
    }),
  );

  const showGenericError = login.isError && !form.formState.errors.email;

  return (
    <>
      <AuthHeading title="Sign in" description="Welcome back. Sign in to your account." />
      <div className="space-y-4">
        {expired && !login.isError ? (
          <InfoAlert title="Your session ended">Please sign in again to continue.</InfoAlert>
        ) : null}
        {passwordReset && !login.isError ? (
          <InfoAlert title="Password updated">Sign in with your new password.</InfoAlert>
        ) : null}
        {showGenericError ? <FormErrorAlert error={login.error} /> : null}
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
            <FormPasswordField
              control={form.control}
              name="password"
              label="Password"
              autoComplete="current-password"
              required
            />
            <div className="-mt-2 flex justify-end">
              <Link
                href={routes.auth.forgotPassword}
                className="text-sm text-primary underline-offset-4 hover:underline"
              >
                Forgot password?
              </Link>
            </div>
            <SubmitButton pending={login.isPending || login.isSuccess}>Sign in</SubmitButton>
          </FieldGroup>
        </form>
        <p className="text-center text-sm text-muted-foreground">
          New here?{' '}
          <Link
            href={routes.auth.register}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Create an account
          </Link>
        </p>
      </div>
    </>
  );
}
