'use client';

import { RouteError } from '@/components/app/route-error';
import { routes } from '@/config/routes';

/** Errors inside member pages render within the shell (sidebar and top bar stay usable). */
export default function MemberError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <RouteError
      error={error}
      retry={retry}
      homeHref={routes.member.dashboard}
      homeLabel="Back to dashboard"
    />
  );
}
