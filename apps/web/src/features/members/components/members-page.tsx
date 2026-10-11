'use client';

import type { ColumnDef } from '@tanstack/react-table';
import { Flag, Search, Users, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo } from 'react';
import { RoleKey, UserStatus, type AdminMemberListItemDto } from '@app/shared';

import { DataTable, useCursorList, useUrlTextFilters } from '@/components/app/data-table';
import { DateTime, RelativeTime } from '@/components/app/date-time';
import { PageHeader } from '@/components/app/page-header';
import { EmptyState } from '@/components/app/states';
import { StatusBadge, ToneBadge } from '@/components/app/status-badge';
import { UserAvatar } from '@/components/app/user-avatar';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { routes } from '@/config/routes';
import { enumOptions } from '@/lib/enum-labels';
import { queryKeys } from '@/lib/query-keys';

import { ADMIN_MEMBERS_PATH, type MemberListFilters } from '../api';
import { RoleBadges } from './role-badges';

const ALL = '__all__';
const SEARCH_DEBOUNCE_MS = 300;

const memberHref = (id: string) => `${routes.admin.members}/${id}`;

function readFilters(params: URLSearchParams): MemberListFilters {
  const status = params.get('status') ?? undefined;
  const role = params.get('role') ?? undefined;
  return {
    q: params.get('q')?.trim() || undefined,
    status: status && (UserStatus as readonly string[]).includes(status) ? status : undefined,
    role: role && (RoleKey as readonly string[]).includes(role) ? role : undefined,
    programId: params.get('programId') ?? undefined,
  };
}

const columns: ColumnDef<AdminMemberListItemDto>[] = [
  {
    id: 'member',
    header: 'Member',
    enableHiding: false,
    cell: ({ row }) => (
      <div className="flex min-w-0 items-center gap-3">
        <UserAvatar name={row.original.fullName} size="sm" />
        <div className="min-w-0">
          <Link href={memberHref(row.original.id)} className="block truncate font-medium hover:underline">
            {row.original.fullName}
          </Link>
          <span className="block truncate text-xs text-muted-foreground">{row.original.email}</span>
        </div>
      </div>
    ),
  },
  {
    id: 'status',
    header: 'Status',
    meta: { label: 'Status' },
    cell: ({ row }) => (
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge kind="UserStatus" value={row.original.status} />
        {!row.original.emailVerified && row.original.status !== 'PENDING_VERIFICATION' ? (
          <ToneBadge tone="warning">Unverified</ToneBadge>
        ) : null}
      </div>
    ),
  },
  {
    id: 'roles',
    header: 'Roles',
    meta: { label: 'Roles' },
    cell: ({ row }) => <RoleBadges roles={row.original.roles} />,
  },
  {
    id: 'activeEnrollments',
    header: 'Enrollments',
    meta: { align: 'right', label: 'Active enrollments' },
    cell: ({ row }) => <span className="tabular-nums">{row.original.activeEnrollments}</span>,
  },
  {
    id: 'openFlags',
    header: 'Flags',
    meta: { align: 'right', label: 'Open flags' },
    cell: ({ row }) =>
      row.original.openFlags > 0 ? (
        <ToneBadge tone="warning" title="Open suspicious-activity flags">
          <Flag className="size-3" aria-hidden />
          {row.original.openFlags}
        </ToneBadge>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    id: 'createdAt',
    header: 'Joined',
    meta: { label: 'Joined' },
    cell: ({ row }) => <DateTime value={row.original.createdAt} style="date" />,
  },
  {
    id: 'lastLoginAt',
    header: 'Last sign-in',
    meta: { label: 'Last sign-in' },
    cell: ({ row }) =>
      row.original.lastLoginAt ? (
        <RelativeTime value={row.original.lastLoginAt} />
      ) : (
        <span className="text-muted-foreground">Never</span>
      ),
  },
];

/** Member search: name/email search, status/role filters (URL-synced), cursor table, mobile cards. */
export function MembersPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useMemo(() => readFilters(new URLSearchParams(searchParams.toString())), [searchParams]);
  const setParams = (patch: Partial<Record<keyof MemberListFilters, string | null | undefined>>) => {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  // Debounce typing into the URL (the list query follows the URL); the box follows URL changes made
  // elsewhere (links with ?q=, back/forward, this route revived by <Activity>).
  const searchText = useUrlTextFilters({ q: filters.q ?? '' }, setParams, SEARCH_DEBOUNCE_MS);
  const search = searchText.text.q;
  const setSearch = (value: string) => searchText.setText('q', value);

  const list = useCursorList<AdminMemberListItemDto>({
    queryKey: queryKeys.admin.members({ ...filters }),
    path: ADMIN_MEMBERS_PATH,
    query: { ...filters },
  });

  const hasFilters = Boolean(filters.q || filters.status || filters.role || filters.programId);
  const clearAll = () => {
    searchText.clear();
    router.replace(pathname, { scroll: false });
  };

  const toolbar = (
    <>
      <InputGroup className="w-full sm:w-72">
        <InputGroupAddon>
          <Search aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or email"
          aria-label="Search members by name or email"
          maxLength={120}
        />
        {search ? (
          <InputGroupAddon align="inline-end">
            <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setSearch('')}>
              <X aria-hidden />
            </InputGroupButton>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
      <Select value={filters.status ?? ALL} onValueChange={(v) => setParams({ status: v === ALL ? undefined : v })}>
        <SelectTrigger className="w-full sm:w-44" aria-label="Filter by status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All statuses</SelectItem>
          {enumOptions('UserStatus').map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={filters.role ?? ALL} onValueChange={(v) => setParams({ role: v === ALL ? undefined : v })}>
        <SelectTrigger className="w-full sm:w-44" aria-label="Filter by role">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All roles</SelectItem>
          {enumOptions('RoleKey').map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {filters.programId ? (
        <ToneBadge tone="primary" className="h-7 gap-1 pr-1">
          Program filter
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-5"
            aria-label="Remove program filter"
            onClick={() => setParams({ programId: undefined })}
          >
            <X aria-hidden />
          </Button>
        </ToneBadge>
      ) : null}
      {hasFilters ? (
        <Button variant="ghost" size="sm" onClick={clearAll}>
          Clear filters
        </Button>
      ) : null}
    </>
  );

  return (
    <>
      <PageHeader
        title="Members"
        description="Search member accounts, review their enrollments and rewards, and manage access."
      />
      <DataTable
        columns={columns}
        data={list.rows}
        isLoading={list.isLoading}
        isFetching={list.isFetching}
        error={list.error}
        onRetry={list.refetch}
        pagination={list.pagination}
        toolbar={toolbar}
        enableColumnVisibility
        caption="Members"
        onRowClick={(m) => router.push(memberHref(m.id))}
        rowLabel={(m) => `Open ${m.fullName}`}
        emptyState={
          <EmptyState
            variant="plain"
            size="sm"
            icon={Users}
            title={hasFilters ? 'No members match these filters' : 'No members yet'}
            description={hasFilters ? 'Try a different name, email or filter.' : 'Members appear here after they verify their email.'}
            action={
              hasFilters ? (
                <Button variant="outline" size="sm" onClick={clearAll}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        }
        renderCard={(m) => (
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2.5">
                <UserAvatar name={m.fullName} size="sm" />
                <div className="min-w-0">
                  <Link href={memberHref(m.id)} className="block truncate font-medium">
                    {m.fullName}
                  </Link>
                  <span className="block truncate text-xs text-muted-foreground">{m.email}</span>
                </div>
              </div>
              <StatusBadge kind="UserStatus" value={m.status} />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <RoleBadges roles={m.roles} />
              <span>
                {m.activeEnrollments} active enrollment{m.activeEnrollments === 1 ? '' : 's'}
                {m.openFlags > 0 ? ` · ${m.openFlags} open flag${m.openFlags === 1 ? '' : 's'}` : ''}
              </span>
            </div>
          </div>
        )}
      />
    </>
  );
}
