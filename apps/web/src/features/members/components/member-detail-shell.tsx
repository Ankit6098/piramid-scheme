'use client';

import { History, Mail } from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Permission } from '@app/shared';

import { ErrorState } from '@/components/app/error-state';
import { useBreadcrumbLabel } from '@/components/app/shell/breadcrumb-store';
import { StatusBadge } from '@/components/app/status-badge';
import { UserAvatar } from '@/components/app/user-avatar';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { routes } from '@/config/routes';
import { useSession } from '@/hooks/use-session';
import { cn } from '@/lib/utils';

import { useAdminMember } from '../api';
import { MemberPasswordResetAction } from './member-password-reset-action';
import { MemberRolesDialog } from './member-roles-dialog';
import { MemberStatusAction } from './member-status-action';
import { RoleBadges } from './role-badges';

/** Header + route tabs shared by every `/admin/members/[id]/*` page. */
export function MemberDetailShell({ children }: { children: ReactNode }) {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const base = `${routes.admin.members}/${id}`;
  const pathname = usePathname();
  // The overview tab's page heading is the member name; nested tabs (Team) render their own <h1>.
  const NameTag = pathname === base ? 'h1' : 'p';
  const { data: member, isPending, error, refetch } = useAdminMember(id);
  const { can } = useSession();
  useBreadcrumbLabel(member?.fullName, base);

  if (error) {
    return <ErrorState error={error} onRetry={() => void refetch()} />;
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        {isPending || !member ? (
          <div className="flex items-center gap-4" aria-busy>
            <Skeleton className="size-12 rounded-full" />
            <div className="space-y-2">
              <Skeleton className="h-7 w-56" />
              <Skeleton className="h-4 w-40" />
            </div>
            <span className="sr-only">Loading member</span>
          </div>
        ) : (
          <>
            <div className="flex min-w-0 items-center gap-4">
              <UserAvatar name={member.fullName} src={member.avatarUrl} size="lg" />
              <div className="min-w-0 space-y-1.5">
                <NameTag className="truncate font-heading text-2xl font-semibold tracking-tight">{member.fullName}</NameTag>
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <Mail className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{member.email}</span>
                  </span>
                  <StatusBadge kind="UserStatus" value={member.status} />
                  <RoleBadges roles={member.roles.map((r) => r.role)} />
                </div>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {can(Permission.AuditRead) ? (
                <Button asChild variant="ghost" size="sm">
                  <Link href={`${routes.admin.audit}?resourceType=user&resourceId=${member.id}`}>
                    <History aria-hidden />
                    Audit history
                  </Link>
                </Button>
              ) : null}
              {member.can.changeRoles ? <MemberRolesDialog member={member} /> : null}
              <MemberPasswordResetAction member={member} />
              <MemberStatusAction member={member} />
            </div>
          </>
        )}
      </header>

      <MemberTabs base={base} />

      <div>{children}</div>
    </div>
  );
}

function MemberTabs({ base }: { base: string }) {
  const pathname = usePathname();
  const tabs = [
    { href: base, label: 'Overview', active: pathname === base },
    { href: `${base}/team`, label: 'Team', active: pathname.startsWith(`${base}/team`) },
  ];
  return (
    <nav aria-label="Member sections" className="border-b">
      <ul className="-mb-px flex gap-4">
        {tabs.map((tab) => (
          <li key={tab.href}>
            <Link
              href={tab.href}
              aria-current={tab.active ? 'page' : undefined}
              className={cn(
                'inline-flex h-10 items-center border-b-2 px-1 text-sm font-medium transition-colors',
                tab.active
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground',
              )}
            >
              {tab.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
