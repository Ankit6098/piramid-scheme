'use client';

import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Permission, type Permission as PermissionKey } from '@app/shared';

import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { useBreadcrumbLabel } from '@/components/app/shell/breadcrumb-store';
import { CardSkeleton } from '@/components/app/states';
import { StatusBadge, ToneBadge } from '@/components/app/status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '@/hooks/use-session';
import { enumLabel } from '@/lib/enum-labels';
import { cn } from '@/lib/utils';

import { useAdminProgram } from '../../api';
import { ProgramLifecycleActions } from './lifecycle-actions';
import { programHref } from './program-links';

type Tab = { label: string; href: string; exact?: boolean; perm?: PermissionKey; count?: number };

/**
 * Layout of /admin/programs/[id]/**: program header (status, offering, unit/currency, lifecycle
 * actions) and route tabs. Tab pages render below once the program has loaded; they read the same
 * cached query (`useAdminProgram`).
 */
export function ProgramDetailShell({ children }: { children: ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  // The policies screens (owned by the policies feature) render their own page header and back link.
  const standalone = pathname.startsWith(`${programHref(id, 'policies')}`);
  const query = useAdminProgram(id);
  // Name instead of the id in the top-bar breadcrumbs, on every program screen.
  useBreadcrumbLabel(query.data?.name, programHref(id));
  return standalone ? (
    <>{children}</>
  ) : (
    <ProgramChrome id={id} pathname={pathname} query={query}>
      {children}
    </ProgramChrome>
  );
}

function ProgramChrome({
  id,
  pathname,
  query,
  children,
}: {
  id: string;
  pathname: string;
  query: ReturnType<typeof useAdminProgram>;
  children: ReactNode;
}) {
  const { can } = useSession();
  const program = query.data;

  if (query.isPending) {
    return (
      <div className="space-y-6" role="status" aria-label="Loading program">
        <div className="space-y-2">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-8 w-full max-w-xl" />
        <CardSkeleton lines={4} />
      </div>
    );
  }
  if (query.error || !program) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const tabs: Tab[] = [
    { label: 'Overview', href: programHref(id), exact: true },
    { label: 'Options', href: programHref(id, 'options'), count: program.options.length },
    { label: 'Policies', href: programHref(id, 'policies'), count: program.policySummary.publishedCount + program.policySummary.draftCount },
    {
      label: 'Enrollments',
      href: programHref(id, 'enrollments'),
      perm: Permission.EnrollmentsManage,
      count: program.enrollmentCounts.PENDING + program.enrollmentCounts.ACTIVE,
    },
    { label: 'Admins', href: programHref(id, 'admins'), count: program.adminCount },
    { label: 'History', href: programHref(id, 'history') },
  ];
  const visible = tabs.filter((t) => !t.perm || can(t.perm));
  const isActive = (t: Tab) => (t.exact ? pathname === t.href : pathname === t.href || pathname.startsWith(`${t.href}/`));
  const editing = pathname === programHref(id, 'edit');

  return (
    <div>
      <PageHeader
        title={program.name}
        description={program.description ?? undefined}
        meta={
          <>
            <StatusBadge kind="ProgramStatus" value={program.status} />
            <ToneBadge tone="neutral" dot={false} title="Program code">
              <span className="font-mono">{program.code}</span>
            </ToneBadge>
            <ToneBadge tone={program.offering.status === 'ACTIVE' ? 'neutral' : 'warning'} title="Offering">
              {program.offering.name}
              {program.offering.status !== 'ACTIVE' ? ' (not approved)' : ''}
            </ToneBadge>
            <ToneBadge tone="neutral" dot={false} title="Reward unit and currency (snapshot)">
              {enumLabel('RewardUnit', program.rewardUnit)} · {program.currencyCode}
            </ToneBadge>
          </>
        }
        actions={editing ? undefined : <ProgramLifecycleActions program={program} />}
      />

      <nav aria-label="Program sections" className="-mx-4 mb-6 overflow-x-auto border-b px-4 sm:mx-0 sm:px-0">
        <ul className="flex min-w-max gap-1">
          {visible.map((t) => {
            const active = isActive(t);
            return (
              <li key={t.href}>
                <Link
                  href={t.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'relative inline-flex h-9 items-center gap-1.5 rounded-t-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground',
                    'after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full',
                    active && 'text-foreground after:bg-primary',
                  )}
                >
                  {t.label}
                  {t.count ? (
                    <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">{t.count}</span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {children}
    </div>
  );
}
