'use client';

import './globals.css';

/** Last-resort boundary for errors in the root layout (renders its own document). */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en">
      <body className="flex min-h-svh items-center justify-center bg-background p-6 font-sans text-foreground antialiased">
        <title>Something went wrong</title>
        <main className="max-w-md space-y-4 text-center">
          <h1 className="text-xl font-semibold tracking-tight">Something went wrong</h1>
          <p className="text-sm text-muted-foreground">
            The application failed to load. Please try again in a moment.
            {error.digest ? ` Reference: ${error.digest}` : null}
          </p>
          <button
            type="button"
            onClick={() => retry()}
            className="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/85 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
