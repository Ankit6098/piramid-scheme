'use client';

import { RouteError } from '@/components/app/route-error';

/** Root error boundary (public pages and anything without a closer boundary). */
export default function ErrorBoundary({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="flex min-h-[60svh] items-center justify-center px-4 py-16 outline-none"
    >
      <RouteError error={error} retry={retry} className="max-w-lg" />
    </main>
  );
}
