'use client';

import { CircleAlert, LogIn, RefreshCw, WifiOff } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { CopyButton } from '@/components/app/copy-button';
import { EmptyState, NotFoundState, PermissionDenied } from '@/components/app/states';
import { Button } from '@/components/ui/button';
import { loginHref } from '@/config/routes';
import { getErrorMessage, isApiError } from '@/lib/api-client';

export interface ErrorStateProps {
  error: unknown;
  /** Called by the "Try again" button (e.g. `query.refetch`). Hidden when omitted. */
  onRetry?: () => void;
  title?: ReactNode;
  /** Use a compact, unbordered layout (inside cards). */
  variant?: 'card' | 'plain';
  className?: string;
}

/**
 * Error display that understands `ApiError`: 401 → sign-in prompt, 403 → permission denied,
 * 404 → not found, network → offline hint; otherwise the API message plus the request id so
 * support can find the log line.
 */
export function ErrorState({
  error,
  onRetry,
  title,
  variant = 'card',
  className,
}: ErrorStateProps) {
  if (isApiError(error)) {
    if (error.isUnauthenticated) {
      return (
        <EmptyState
          icon={LogIn}
          variant={variant}
          className={className}
          title="Your session has ended"
          description="Please sign in again to continue."
          action={
            <Button asChild>
              <Link href={loginHref(null, { expired: true })}>Sign in</Link>
            </Button>
          }
        />
      );
    }
    if (error.isForbidden && !error.isMfaRequired)
      return <PermissionDenied className={className} />;
    if (error.isNotFound)
      return (
        <NotFoundState className={className} backHref="/dashboard" backLabel="Back to dashboard" />
      );
  }

  const network = isApiError(error) && error.isNetworkError;
  const requestId = isApiError(error) ? error.requestId : undefined;

  return (
    <EmptyState
      icon={network ? WifiOff : CircleAlert}
      variant={variant}
      className={className}
      title={title ?? (network ? 'You appear to be offline' : 'Something went wrong')}
      description={
        <div className="space-y-2" role="alert">
          <p>{getErrorMessage(error)}</p>
          {requestId ? (
            <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              Request ID <code className="rounded bg-muted px-1 py-0.5 font-mono">{requestId}</code>
              <CopyButton value={requestId} label="request ID" variant="ghost" size="icon-xs" />
            </p>
          ) : null}
        </div>
      }
      action={
        onRetry ? (
          <Button variant="outline" onClick={onRetry}>
            <RefreshCw aria-hidden />
            Try again
          </Button>
        ) : null
      }
    />
  );
}
