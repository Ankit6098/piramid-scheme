'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, Mail, ShieldCheck, Smartphone } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  mfaCodeSchema,
  type MfaCodeInput,
  type MfaCodeRequest,
  type MfaEmailSentResponseDto,
  type SessionUserDto,
  type TotpSetupResponseDto,
} from '@app/shared';

import { AuthHeading } from '@/components/app/auth-heading';
import { CopyButton } from '@/components/app/copy-button';
import { ErrorState } from '@/components/app/error-state';
import { FormSkeleton } from '@/components/app/states';
import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { loginHref, routes } from '@/config/routes';
import { useLogout, useSession } from '@/hooks/use-session';
import { applyApiFieldErrors } from '@/components/app/form';

import {
  useConfirmTotp,
  useSendMfaEmailCode,
  useStartTotpSetup,
  useVerifyMfaEmailCode,
  useVerifyTotp,
} from '../api';
import { destinationAfterAuth, hardNavigate } from '../lib/navigation';
import { FormErrorAlert, InfoAlert, ResendButton, SubmitButton } from './auth-bits';
import { FormOtpField } from './form-fields';
import { TotpQrCode } from './totp-qr';

type Step = 'email' | 'setup' | 'totp' | 'done';

/** Which second-factor step this admin session needs next. */
function stepFor(user: SessionUserDto): Step {
  if (user.hasTotpFactor) return user.adminAccess ? 'done' : 'totp';
  return user.mfaMethod ? 'setup' : 'email';
}

/** A 6-digit code form used by every step. */
function CodeForm({
  label,
  submitLabel,
  pending,
  error,
  onSubmit,
}: {
  label: string;
  submitLabel: string;
  pending: boolean;
  error: unknown;
  onSubmit: (code: string, form: ReturnType<typeof useCodeForm>) => void;
}) {
  const form = useCodeForm();
  const submit = form.handleSubmit((values) => onSubmit(values.code, form));
  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        {error && !form.formState.errors.code ? <FormErrorAlert error={error} /> : null}
        <FormOtpField
          control={form.control}
          name="code"
          label={label}
          autoFocus
          required
          onComplete={() => {
            if (!pending) void submit();
          }}
        />
        <SubmitButton pending={pending}>{submitLabel}</SubmitButton>
      </FieldGroup>
    </form>
  );
}

function useCodeForm() {
  return useForm<MfaCodeInput, unknown, MfaCodeRequest>({
    resolver: zodResolver(mfaCodeSchema),
    defaultValues: { code: '' },
  });
}

function failed(form: ReturnType<typeof useCodeForm>, error: unknown) {
  applyApiFieldErrors(error, form.setError, { knownFields: ['code'] });
  form.setValue('code', '');
  form.setFocus('code');
}

// ─── Steps ───────────────────────────────────────────────────────────────────

function EmailCodeStep() {
  const send = useSendMfaEmailCode();
  const verify = useVerifyMfaEmailCode();
  const [sent, setSent] = useState<(MfaEmailSentResponseDto & { at: number }) | null>(null);

  const requestCode = () =>
    send.mutate(undefined, { onSuccess: (res) => setSent({ ...res, at: Date.now() }) });

  return (
    <>
      <AuthHeading
        title="Confirm it's you"
        description="Admin accounts use two-step verification. First, confirm your email address with a one-time code."
      />
      <div className="space-y-4">
        {send.isError ? <FormErrorAlert error={send.error} /> : null}
        {sent ? (
          <>
            <InfoAlert>
              We sent a 6-digit code to <span className="font-medium">{sent.sentTo}</span>. It
              expires in 10 minutes.
            </InfoAlert>
            <CodeForm
              label="Email code"
              submitLabel="Verify email code"
              pending={verify.isPending}
              error={verify.error}
              onSubmit={(code, form) => verify.mutate(code, { onError: (e) => failed(form, e) })}
            />
            <div className="text-center text-sm">
              <ResendButton
                availableAt={sent.at + sent.resendAfterSeconds * 1000}
                onResend={requestCode}
                pending={send.isPending}
              />
            </div>
          </>
        ) : (
          <Button className="w-full" onClick={requestCode} disabled={send.isPending}>
            {send.isPending ? <Spinner /> : <Mail aria-hidden />}
            Email me a code
          </Button>
        )}
      </div>
    </>
  );
}

function TotpSetupStep({ next }: { next: string | null }) {
  const queryClient = useQueryClient();
  const setup = useStartTotpSetup();
  const confirm = useConfirmTotp();
  const [secret, setSecret] = useState<TotpSetupResponseDto | null>(null);

  const start = () => setup.mutate(undefined, { onSuccess: setSecret });

  return (
    <>
      <AuthHeading
        title="Set up your authenticator"
        description="Admin access requires an authenticator app (such as Google Authenticator, Microsoft Authenticator or 1Password)."
      />
      <div className="space-y-5">
        {setup.isError ? <FormErrorAlert error={setup.error} /> : null}
        {secret ? (
          <>
            <ol className="space-y-4 text-sm">
              <li className="space-y-3">
                <p>
                  <span className="font-medium">1.</span> Scan this QR code with your authenticator
                  app.
                </p>
                <div className="flex justify-center">
                  <TotpQrCode uri={secret.otpauthUri} accountName={secret.accountName} />
                </div>
                <div className="space-y-1.5">
                  <p className="text-muted-foreground">
                    Can&apos;t scan it? Enter this setup key instead:
                  </p>
                  <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2">
                    <code
                      className="min-w-0 flex-1 font-mono text-sm tracking-wider break-all"
                      aria-label="Setup key"
                    >
                      {secret.secret.match(/.{1,4}/g)?.join(' ')}
                    </code>
                    <CopyButton value={secret.secret} label="Copy setup key" />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Shown only now. Keep it private — anyone with this key can generate your codes.
                  </p>
                </div>
              </li>
              <li>
                <p className="mb-3">
                  <span className="font-medium">2.</span> Enter the 6-digit code the app shows.
                </p>
                <CodeForm
                  label="Authenticator code"
                  submitLabel="Confirm and continue"
                  pending={confirm.isPending || confirm.isSuccess}
                  error={confirm.error}
                  onSubmit={(code, form) =>
                    confirm.mutate(code, {
                      onSuccess: (res) =>
                        hardNavigate(queryClient, destinationAfterAuth(res.user, next)),
                      onError: (e) => failed(form, e),
                    })
                  }
                />
              </li>
            </ol>
            <Button
              variant="link"
              className="h-auto w-full px-0"
              onClick={start}
              disabled={setup.isPending}
            >
              Generate a new QR code
            </Button>
          </>
        ) : (
          <Button className="w-full" onClick={start} disabled={setup.isPending}>
            {setup.isPending ? <Spinner /> : <Smartphone aria-hidden />}
            Show QR code
          </Button>
        )}
      </div>
    </>
  );
}

function TotpVerifyStep({ next }: { next: string | null }) {
  const queryClient = useQueryClient();
  const verify = useVerifyTotp();
  return (
    <>
      <AuthHeading
        title="Two-step verification"
        description="Enter the 6-digit code from your authenticator app."
      />
      <div className="space-y-4">
        <CodeForm
          label="Authenticator code"
          submitLabel="Verify"
          pending={verify.isPending || verify.isSuccess}
          error={verify.error}
          onSubmit={(code, form) =>
            verify.mutate(code, {
              onSuccess: (res) => hardNavigate(queryClient, destinationAfterAuth(res.user, next)),
              onError: (e) => failed(form, e),
            })
          }
        />
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <KeyRound className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Lost access to your authenticator? Ask a Super Admin to reset it for you.
        </p>
      </div>
    </>
  );
}

// ─── Flow ────────────────────────────────────────────────────────────────────

/**
 * /mfa — second step for admin sessions: email code (first sign-in) → authenticator setup, or the
 * authenticator code. Derives the step from the session; members and fully verified admins are sent on.
 */
export function MfaFlow() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get('next');
  const queryClient = useQueryClient();
  const { user, status, error, refetch } = useSession();
  const logout = useLogout();
  const step = user ? stepFor(user) : null;

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.replace(
        loginHref(`${window.location.pathname}${window.location.search}`, { expired: true }),
      );
    } else if (user && !user.isAdmin) {
      router.replace(routes.member.dashboard);
    } else if (user && step === 'done') {
      hardNavigate(queryClient, destinationAfterAuth(user, next));
    }
  }, [status, user, step, next, router, queryClient]);

  if (status === 'error') return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!user || !user.isAdmin || step === 'done') return <FormSkeleton fields={2} />;

  return (
    <div className="space-y-6">
      {step === 'email' ? <EmailCodeStep /> : null}
      {step === 'setup' ? <TotpSetupStep next={next} /> : null}
      {step === 'totp' ? <TotpVerifyStep next={next} /> : null}
      <div className="flex flex-col items-center gap-2 border-t pt-4 text-sm">
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <ShieldCheck className="size-4" aria-hidden />
          Signed in as <span className="font-medium text-foreground">{user.email}</span>
        </p>
        <div className="flex flex-wrap justify-center gap-x-4 gap-y-1">
          <Link
            href={routes.member.dashboard}
            className="text-primary underline-offset-4 hover:underline"
          >
            Continue to the member area
          </Link>
          <button
            type="button"
            className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
