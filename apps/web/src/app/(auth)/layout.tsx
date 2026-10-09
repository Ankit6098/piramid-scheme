import Link from 'next/link';
import { Suspense, type ReactNode } from 'react';

import { BrandMark } from '@/components/app/shell/brand-mark';
import { ThemeToggle } from '@/components/app/shell/theme-toggle';
import { FormSkeleton } from '@/components/app/states';
import { Card } from '@/components/ui/card';
import { routes } from '@/config/routes';

/**
 * Centered-card layout for sign-in, registration, verification and recovery screens.
 * Pages render their content (start with <AuthHeading>) directly inside the card.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href={routes.home} className="rounded-md" aria-label="Home">
          <BrandMark />
        </Link>
        <ThemeToggle />
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        className="flex flex-1 items-start justify-center px-4 pt-6 pb-16 outline-none sm:items-center sm:pt-0"
      >
        <div className="w-full max-w-md">
          <Card className="px-6 py-8 sm:px-8">
            {/* Auth pages read search params (?next, ?ref, ?token) — keep them inside Suspense. */}
            <Suspense fallback={<FormSkeleton fields={2} />}>{children}</Suspense>
          </Card>
          <p className="mt-6 text-center text-xs text-muted-foreground">
            Rewards are earned only from qualifying sales of approved products and services.
          </p>
        </div>
      </main>
    </div>
  );
}
