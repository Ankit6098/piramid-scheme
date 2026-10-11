'use client';

/** Small building blocks shared by the auth screens. */
import { AlertCircle, MailCheck } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { getErrorMessage, isApiError } from '@/lib/api-client';

/** Inline error for a failed submit (field errors are shown on the fields themselves). */
export function FormErrorAlert({ error, title }: { error: unknown; title?: string }) {
  if (!error) return null;
  // `details.retryAfterSeconds`, else the Retry-After header (any 429, incl. the IP throttler).
  const retryAfter = isApiError(error) ? (error.retryAfterSeconds ?? 0) : 0;
  return (
    <Alert variant="destructive" role="alert">
      <AlertCircle aria-hidden />
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      <AlertDescription>
        {getErrorMessage(error)}
        {retryAfter > 0 ? ` (try again in ${formatWait(retryAfter)})` : null}
      </AlertDescription>
    </Alert>
  );
}

/** Neutral confirmation, e.g. "If an account exists, we sent a code". */
export function InfoAlert({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <Alert role="status">
      <MailCheck aria-hidden />
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

export function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.ceil(minutes / 60)} h`;
}

/**
 * Seconds left until `until` (epoch ms), ticking every second. Without `until`, counts down
 * `initialSeconds` from mount (e.g. a code was just sent by the previous screen). Returns null before
 * the first client tick (never reads the clock during render).
 */
export function useCountdown(until: number | null, initialSeconds = 0): number | null {
  const [clock, setClock] = useState<{ now: number; mountedAt: number } | null>(null);
  useEffect(() => {
    const tick = () =>
      setClock((prev) => ({ now: Date.now(), mountedAt: prev?.mountedAt ?? Date.now() }));
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);
  if (!clock) return null;
  const target = until ?? (initialSeconds > 0 ? clock.mountedAt + initialSeconds * 1000 : null);
  return target ? Math.max(0, Math.ceil((target - clock.now) / 1000)) : 0;
}

export interface ResendButtonProps {
  /** Epoch ms after which resending is allowed (null = use `initialCooldownSeconds` from mount). */
  availableAt: number | null;
  /** Cooldown counted from mount when `availableAt` is not known yet. */
  initialCooldownSeconds?: number;
  onResend: () => void;
  pending?: boolean;
  label?: string;
}

/** "Resend code" with a visible countdown (the server enforces the same 60 s cooldown). */
export function ResendButton({
  availableAt,
  initialCooldownSeconds = 0,
  onResend,
  pending,
  label = 'Resend code',
}: ResendButtonProps) {
  const left = useCountdown(availableAt, initialCooldownSeconds);
  return (
    <Button
      type="button"
      variant="link"
      className="h-auto px-0"
      onClick={onResend}
      disabled={pending || left === null || left > 0}
    >
      {pending ? <Spinner /> : null}
      {left !== null && left > 0 ? (
        <span>
          {label} in <span className="tabular-nums">{left}</span> s
        </span>
      ) : (
        label
      )}
    </Button>
  );
}

/** Primary submit button with a pending spinner. */
export function SubmitButton({
  pending,
  children,
  className,
}: {
  pending: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Button
      type="submit"
      className={className ?? 'w-full'}
      disabled={pending}
      aria-busy={pending || undefined}
    >
      {pending ? <Spinner /> : null}
      {children}
    </Button>
  );
}
