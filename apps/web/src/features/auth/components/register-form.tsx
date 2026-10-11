'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { UserRoundCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { ErrorCode, registerSchema, type RegisterInput, type RegisterRequest } from '@app/shared';

import { AuthHeading } from '@/components/app/auth-heading';
import { applyApiFieldErrors, FormTextField } from '@/components/app/form';
import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field';
import { routes } from '@/config/routes';
import { isApiError } from '@/lib/api-client';

import { previewReferralCode, useRegister } from '../api';
import { rememberPendingEmail } from '../lib/navigation';
import { useResetWhenHidden } from '../lib/use-reset-when-hidden';
import { authKeys } from '../query-keys';
import { FormErrorAlert, SubmitButton } from './auth-bits';
import { FormPasswordField, NEW_PASSWORD_HINT } from './form-fields';

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Normalized like the API does (spaces/dashes removed, upper-case). */
function normalizeCode(code: string | undefined): string {
  return (code ?? '').replace(/[\s-]/g, '').toUpperCase();
}

/** "Invited by Anita S." — only shown when the referrals service confirms the code. */
function InvitedBy({ code }: { code: string }) {
  const normalized = useDebounced(normalizeCode(code), 400);
  const enabled = normalized.length >= 6 && normalized.length <= 16;
  const preview = useQuery({
    queryKey: authKeys.referralPreview(normalized),
    queryFn: ({ signal }) => previewReferralCode(normalized, signal),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
  if (!enabled || !preview.data) return null;
  if (!preview.data.valid) {
    return (
      <p className="text-sm text-muted-foreground">
        We couldn&apos;t find this referral code. Check it, or continue without one.
      </p>
    );
  }
  if (!preview.data.sponsorDisplayName) return null;
  return (
    <p className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm" role="status">
      <UserRoundCheck className="size-4 text-primary" aria-hidden />
      <span>
        Invited by <span className="font-medium">{preview.data.sponsorDisplayName}</span>
      </span>
    </p>
  );
}

/**
 * Registration. The account is created only after the emailed code is verified (on /verify-email);
 * the referral code (prefilled from `?ref=`) is validated now and attributed at verification.
 */
export function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const ref = searchParams.get('ref') ?? '';
  const register = useRegister();

  const form = useForm<RegisterInput, unknown, RegisterRequest>({
    resolver: zodResolver(registerSchema),
    defaultValues: { fullName: '', email: '', password: '', referralCode: ref },
  });
  const referralCode = useWatch({ control: form.control, name: 'referralCode' });
  const codeRejected = form.formState.errors.referralCode?.type === 'server';
  // Returning to this (Activity-preserved) screen shows a fresh form, not the last submission.
  useResetWhenHidden(() => {
    register.reset();
    form.reset({ fullName: '', email: '', password: '', referralCode: ref });
  });
  // A preserved screen re-shown for another invitation link picks up the new `?ref=` (unless edited).
  useEffect(() => {
    if (!form.getFieldState('referralCode').isDirty) form.setValue('referralCode', ref);
  }, [ref, form]);
  // One registration per submit: a second click while the first is pending or navigating to the code
  // screen would issue a new code and invalidate the one just sent.
  const submitting = register.isPending || register.isSuccess;

  const onSubmit = form.handleSubmit((values) => {
    if (submitting) return;
    register.mutate(values, {
      onSuccess: () => {
        rememberPendingEmail(values.email);
        router.push(routes.auth.verifyEmail);
      },
      onError: (error) => {
        if (isApiError(error) && error.code === ErrorCode.ReferralCodeInvalid) {
          form.setError(
            'referralCode',
            {
              type: 'server',
              message:
                'This referral code is not valid. Check it, or remove it to continue without one.',
            },
            { shouldFocus: true },
          );
          return;
        }
        applyApiFieldErrors(error, form.setError, {
          knownFields: ['fullName', 'email', 'password', 'referralCode'],
        });
      },
    });
  });

  const showGenericError =
    register.isError &&
    !(
      isApiError(register.error) &&
      (register.error.hasFieldErrors || register.error.code === ErrorCode.ReferralCodeInvalid)
    );

  return (
    <>
      <AuthHeading
        title="Create your account"
        description="We'll email you a code to confirm your address."
      />
      <div className="space-y-4">
        {showGenericError ? <FormErrorAlert error={register.error} /> : null}
        <form onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <FormTextField
              control={form.control}
              name="fullName"
              label="Full name"
              autoComplete="name"
              autoFocus
              required
            />
            <FormTextField
              control={form.control}
              name="email"
              label="Email"
              type="email"
              autoComplete="email"
              inputMode="email"
              required
            />
            <FormPasswordField
              control={form.control}
              name="password"
              label="Password"
              autoComplete="new-password"
              description={NEW_PASSWORD_HINT}
              required
            />
            <div className="space-y-2">
              <FormTextField
                control={form.control}
                name="referralCode"
                label="Referral code (optional)"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                description="If someone invited you, enter their code. It is linked to your account when you confirm your email."
              />
              {codeRejected ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    form.setValue('referralCode', '');
                    form.clearErrors('referralCode');
                  }}
                >
                  Continue without a code
                </Button>
              ) : (
                <InvitedBy code={referralCode ?? ''} />
              )}
            </div>
            <SubmitButton pending={submitting}>Create account</SubmitButton>
          </FieldGroup>
        </form>
        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{' '}
          <Link
            href={routes.auth.login}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
        </p>
      </div>
    </>
  );
}
