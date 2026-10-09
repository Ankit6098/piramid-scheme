'use client';

/**
 * Client-side route/feature guards. These only shape the UI — every request is authorized by the
 * API (`docs/security`). Wrap in <Suspense> (the shells already do) because they read the session.
 */
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import type { Permission } from '@app/shared';

import { ErrorState } from '@/components/app/error-state';
import { PageSkeleton, PermissionDenied } from '@/components/app/states';
import { loginHref, mfaHref, routes } from '@/config/routes';
import { useSession } from '@/hooks/use-session';

function currentPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

export interface RequireAuthProps {
  children: ReactNode;
  /**
   * `admin` additionally requires an admin role and a completed second factor (`mfaVerified`);
   * non-admins see a permission-denied state, unverified admins are sent to /mfa.
   */
  area?: 'member' | 'admin';
  /** Shown while the session loads or a redirect is in flight. */
  fallback?: ReactNode;
}

/**
 * Renders children only for a signed-in user. Signed-out users (expired/revoked cookie) are sent to
 * `/login?next=…&expired=1` — the proxy only checks cookie presence.
 */
export function RequireAuth({ children, area = 'member', fallback }: RequireAuthProps) {
  const router = useRouter();
  const { user, status, error, refetch } = useSession();

  const redirect: 'login' | 'mfa' | null =
    status === 'unauthenticated'
      ? 'login'
      : area === 'admin' && user?.isAdmin && !user.mfaVerified
        ? 'mfa'
        : null;

  useEffect(() => {
    if (redirect === 'login') router.replace(loginHref(currentPath(), { expired: true }));
    else if (redirect === 'mfa') router.replace(mfaHref(currentPath()));
  }, [redirect, router]);

  if (status === 'loading' || redirect) return <>{fallback ?? <PageSkeleton />}</>;
  if (status === 'error') return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (area === 'admin' && !user?.isAdmin) {
    return (
      <PermissionDenied
        title="Admin access required"
        description="The admin console is only available to accounts with an administrative role."
        backHref={routes.member.dashboard}
      />
    );
  }
  return <>{children}</>;
}

export interface PermissionCheckProps {
  /** Required permission. */
  perm?: Permission;
  /** Passes when the user holds ANY of these. */
  anyOf?: readonly Permission[];
  /** Passes only when the user holds ALL of these. */
  allOf?: readonly Permission[];
}

/** Hook form of the permission check (`true` while the session is still loading is never returned). */
export function usePermissionCheck({ perm, anyOf, allOf }: PermissionCheckProps): {
  allowed: boolean;
  loading: boolean;
} {
  const { status, can, canAny, canAll } = useSession();
  if (status === 'loading') return { allowed: false, loading: true };
  const allowed =
    (perm ? can(perm) : true) && (anyOf ? canAny(anyOf) : true) && (allOf ? canAll(allOf) : true);
  return { allowed, loading: false };
}

export interface RequirePermissionProps extends PermissionCheckProps {
  children: ReactNode;
  /** Rendered when the check fails. Defaults to the full-page `<PermissionDenied>`. */
  fallback?: ReactNode;
  /** Rendered while the session loads. */
  loading?: ReactNode;
}

/**
 * Page/section guard: renders children when the user has the permission(s), otherwise a
 * permission-denied state.
 *
 * @example <RequirePermission perm={Permission.LedgerRead}>…</RequirePermission>
 */
export function RequirePermission({
  children,
  fallback,
  loading,
  ...check
}: RequirePermissionProps) {
  const result = usePermissionCheck(check);
  if (result.loading) return <>{loading ?? <PageSkeleton />}</>;
  if (!result.allowed)
    return (
      <>
        {fallback ?? (
          <PermissionDenied backHref={routes.admin.overview} backLabel="Back to overview" />
        )}
      </>
    );
  return <>{children}</>;
}

/**
 * Inline variant: renders children only when allowed, nothing otherwise (buttons, menu items).
 *
 * @example <Can perm={Permission.RewardsApprove}><Button>Approve</Button></Can>
 */
export function Can({
  children,
  fallback = null,
  ...check
}: PermissionCheckProps & { children: ReactNode; fallback?: ReactNode }) {
  const result = usePermissionCheck(check);
  return <>{result.allowed ? children : fallback}</>;
}
