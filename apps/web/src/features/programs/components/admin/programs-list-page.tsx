'use client';

import type { ColumnDef } from '@tanstack/react-table';
import { Boxes, FilterX, Plus } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';
import { Permission, ProgramStatus, type AdminProgramSummaryDto } from '@app/shared';

import { DataTable, useCursorList } from '@/components/app/data-table';
import { DateTime } from '@/components/app/date-time';
import { Can } from '@/components/app/guards';
import { PageHeader } from '@/components/app/page-header';
import { EmptyState } from '@/components/app/states';
import { StatusBadge } from '@/components/app/status-badge';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { enumLabel } from '@/lib/enum-labels';
import { queryKeys } from '@/lib/query-keys';

import { ADMIN_PROGRAMS_PATH } from '../../api';
import { SearchInput } from '../list-toolbar';
import { programHref, PROGRAMS_HREF } from './program-links';

const ALL = 'ALL';

function useProgramFilters() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const rawStatus = params.get('status');
  const status = rawStatus && (ProgramStatus as readonly string[]).includes(rawStatus) ? (rawStatus as ProgramStatus) : undefined;
  const q = params.get('q')?.slice(0, 100) ?? '';
  const set = useCallback(
    (patch: { status?: ProgramStatus | null; q?: string | null }) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        if (value === null || value === '') next.delete(key);
        else next.set(key, value);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );
  return { status, q, set };
}

/** /admin/programs — programs the admin may see (program admins: assigned programs only). */
export function ProgramsListPage() {
  const router = useRouter();
  const { status, q, set } = useProgramFilters();
  const query = useMemo(() => ({ status, q: q || undefined }), [status, q]);
  const list = useCursorList<AdminProgramSummaryDto>({ queryKey: queryKeys.admin.programs(query), path: ADMIN_PROGRAMS_PATH, query });

  const columns = useMemo<ColumnDef<AdminProgramSummaryDto>[]>(
    () => [
      {
        id: 'program',
        header: 'Program',
        cell: ({ row }) => (
          <div className="min-w-0 max-w-xs">
            <Link href={programHref(row.original.id)} className="block truncate font-medium hover:underline">
              {row.original.name}
            </Link>
            <p className="truncate font-mono text-xs text-muted-foreground">{row.original.code}</p>
          </div>
        ),
      },
      { id: 'status', header: 'Status', cell: ({ row }) => <StatusBadge kind="ProgramStatus" value={row.original.status} /> },
      {
        id: 'offering',
        header: 'Offering',
        cell: ({ row }) => (
          <div className="min-w-0 max-w-48">
            <p className="truncate">{row.original.offering.name}</p>
            {row.original.offering.status !== 'ACTIVE' ? <p className="text-xs text-warning">Not approved</p> : null}
          </div>
        ),
      },
      {
        id: 'unit',
        header: 'Rewards',
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-xs">
            {enumLabel('RewardUnit', row.original.rewardUnit)} · {row.original.currencyCode}
          </span>
        ),
      },
      {
        id: 'schedule',
        header: 'Schedule',
        cell: ({ row }) => (
          <div className="text-xs">
            <DateTime value={row.original.startsAt} timeZone={row.original.timezone} style="date" />
            <span className="text-muted-foreground"> → </span>
            {row.original.endsAt ? (
              <DateTime value={row.original.endsAt} timeZone={row.original.timezone} style="date" />
            ) : (
              <span className="text-muted-foreground">open-ended</span>
            )}
          </div>
        ),
      },
      {
        id: 'enrollments',
        header: 'Enrollments',
        meta: { align: 'right' },
        cell: ({ row }) => (
          <div className="text-right tabular-nums">
            <p>{row.original.activeEnrollmentCount} active</p>
            {row.original.pendingEnrollmentCount > 0 ? (
              <p className="text-xs text-warning">{row.original.pendingEnrollmentCount} pending</p>
            ) : null}
          </div>
        ),
      },
      {
        id: 'options',
        header: 'Plans',
        meta: { align: 'right' },
        cell: ({ row }) => <span className="tabular-nums">{row.original.activeOptionCount}</span>,
      },
    ],
    [],
  );

  const newButton = (
    <Can perm={Permission.ProgramsWrite}>
      <Button asChild>
        <Link href={`${PROGRAMS_HREF}/new`}>
          <Plus aria-hidden />
          New program
        </Link>
      </Button>
    </Can>
  );

  const filtered = Boolean(status || q);

  return (
    <div>
      <PageHeader
        title="Programs"
        description="Each program is built on one approved offering, with plans members can enroll in and effective-dated reward policies funded by qualifying sales."
        actions={newButton}
      />
      <DataTable
        columns={columns}
        data={list.rows}
        isLoading={list.isLoading}
        isFetching={list.isFetching}
        error={list.error}
        onRetry={list.refetch}
        pagination={list.pagination}
        caption="Programs"
        onRowClick={(p) => router.push(programHref(p.id))}
        rowLabel={(p) => `Open ${p.name}`}
        toolbar={
          <>
            <SearchInput value={q} onChange={(value) => set({ q: value || null })} placeholder="Search name or code" />
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={status ?? ALL}
              onValueChange={(value) => set({ status: !value || value === ALL ? null : (value as ProgramStatus) })}
              aria-label="Filter by status"
              className="flex-wrap"
            >
              <ToggleGroupItem value={ALL}>All</ToggleGroupItem>
              {ProgramStatus.map((s) => (
                <ToggleGroupItem key={s} value={s}>
                  {enumLabel('ProgramStatus', s)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </>
        }
        emptyState={
          filtered ? (
            <EmptyState
              variant="plain"
              size="sm"
              icon={FilterX}
              title="No programs match these filters"
              action={
                <Button variant="outline" onClick={() => set({ status: null, q: null })}>
                  Reset filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              variant="plain"
              icon={Boxes}
              title="No programs yet"
              description="Create a program for an approved offering, add plans and a reward policy, then publish it."
              action={newButton}
            />
          )
        }
        renderCard={(p) => (
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <Link href={programHref(p.id)} className="block truncate font-medium">
                  {p.name}
                </Link>
                <p className="truncate font-mono text-xs text-muted-foreground">{p.code}</p>
              </div>
              <StatusBadge kind="ProgramStatus" value={p.status} />
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {p.offering.name} · {enumLabel('RewardUnit', p.rewardUnit)} · {p.currencyCode}
            </p>
            <p className="text-xs tabular-nums">
              {p.activeEnrollmentCount} active · {p.pendingEnrollmentCount} pending · {p.activeOptionCount} plans
            </p>
          </div>
        )}
      />
    </div>
  );
}
