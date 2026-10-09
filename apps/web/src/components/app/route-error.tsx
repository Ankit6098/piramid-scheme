'use client';

import { CircleAlert, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useEffect } from 'react';

import { EmptyState } from '@/components/app/states';
import { Button } from '@/components/ui/button';

export interface RouteErrorProps {
  error: Error & { digest?: string };
  retry: () => void;
  homeHref?: string;
  homeLabel?: string;
  className?: string;
}

/** Body of `error.tsx` boundaries: message, server digest reference, retry + home actions. */
export function RouteError({
  error,
  retry,
  homeHref = '/',
  homeLabel = 'Go home',
  className,
}: RouteErrorProps) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <EmptyState
      icon={CircleAlert}
      className={className}
      title="Something went wrong"
      description={
        <span className="space-y-2">
          <span className="block">
            An unexpected error stopped this page from loading. Try again, or come back later.
          </span>
          {error.digest ? (
            <span className="block text-xs">
              Reference{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">{error.digest}</code>
            </span>
          ) : null}
        </span>
      }
      action={
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => retry()}>
            <RefreshCw aria-hidden />
            Try again
          </Button>
          <Button asChild variant="outline">
            <Link href={homeHref}>{homeLabel}</Link>
          </Button>
        </div>
      }
    />
  );
}
