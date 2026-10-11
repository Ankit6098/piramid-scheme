'use client';

import type { ColumnDef } from '@tanstack/react-table';
import { CheckCircle2, Flag, Network, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { FlagKind, FlagStatus, type FlagDto } from '@app/shared';

import { ConfirmDialog } from '@/components/app/confirm-dialog';
import { DataTable } from '@/components/app/data-table';
import { DateTime } from '@/components/app/date-time';
import { PageHeader } from '@/components/app/page-header';
import { EmptyState } from '@/components/app/states';
import { StatusBadge, ToneBadge } from '@/components/app/status-badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { routes } from '@/config/routes';
import { useSession } from '@/hooks/use-session';
import { enumLabel } from '@/lib/enum-labels';

import { useFlags, useResolveFlag, type FlagFilters } from '../api';
import { RaiseFlagDialog } from './raise-flag-dialog';

const KIND_LABELS: Record<string, string> = {
  [FlagKind.SharedIpRegistrations]: 'Shared IP sign-ups',
  [FlagKind.ManualReport]: 'Manual report',
};

export function flagKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function KindBadge({ kind }: { kind: string }) {
  return (
    <ToneBadge tone={kind === FlagKind.ManualReport ? 'neutral' : 'warning'} dot={false}>
      {flagKindLabel(kind)}
    </ToneBadge>
  );
}

/** `/admin/flags`: advisory suspicious-activity signals to review, resolve or dismiss. */
export function FlagsPage() {
  const [status, setStatus] = useState<FlagStatus | 'ALL'>('OPEN');
  const [kind, setKind] = useState<string>('ALL');
  const [detail, setDetail] = useState<FlagDto | null>(null);
  const filters: FlagFilters = {
    ...(status !== 'ALL' ? { status } : {}),
    ...(kind !== 'ALL' ? { kind } : {}),
  };
  const list = useFlags(filters);

  const columns: ColumnDef<FlagDto>[] = [
    {
      id: 'member',
      header: 'Member',
      cell: ({ row }) => (
        <div className="min-w-0">
          <Link
            href={`${routes.admin.members}/${row.original.user.id}/team`}
            className="font-medium text-foreground hover:underline"
          >
            {row.original.user.fullName}
          </Link>
          {row.original.user.status !== 'ACTIVE' ? (
            <div className="mt-0.5">
              <StatusBadge kind="UserStatus" value={row.original.user.status} />
            </div>
          ) : null}
        </div>
      ),
    },
    { id: 'kind', header: 'Signal', cell: ({ row }) => <KindBadge kind={row.original.kind} /> },
    {
      id: 'details',
      header: 'Details',
      meta: { cellClassName: 'max-w-md whitespace-normal' },
      cell: ({ row }) => (
        <button
          type="button"
          className="line-clamp-2 text-left text-sm text-muted-foreground hover:text-foreground"
          onClick={() => setDetail(row.original)}
        >
          {row.original.details}
        </button>
      ),
    },
    { id: 'status', header: 'Status', cell: ({ row }) => <StatusBadge kind="FlagStatus" value={row.original.status} /> },
    {
      id: 'createdAt',
      header: 'Raised',
      cell: ({ row }) => (
        <div className="text-sm">
          <DateTime value={row.original.createdAt} style="date" />
          <div className="text-xs text-muted-foreground">{row.original.createdBy?.fullName ?? 'Automatic'}</div>
        </div>
      ),
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      meta: { align: 'right' },
      cell: ({ row }) => <FlagActions flag={row.original} />,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Flags"
        description="Advisory signals about possible self-referral or fake sign-ups. Flags never change balances — review the accounts and resolve or dismiss each one."
        actions={<RaiseFlagDialog />}
      />
      <DataTable
        columns={columns}
        data={list.rows}
        isLoading={list.isLoading}
        isFetching={list.isFetching}
        error={list.error}
        onRetry={list.refetch}
        pagination={list.pagination}
        caption="Suspicious-activity flags"
        toolbar={
          <>
            <Select value={status} onValueChange={(v) => setStatus(v as FlagStatus | 'ALL')}>
              <SelectTrigger size="sm" className="w-36" aria-label="Filter by status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All statuses</SelectItem>
                {FlagStatus.map((s) => (
                  <SelectItem key={s} value={s}>
                    {enumLabel('FlagStatus', s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger size="sm" className="w-44" aria-label="Filter by signal">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All signals</SelectItem>
                {Object.values(FlagKind).map((k) => (
                  <SelectItem key={k} value={k}>
                    {flagKindLabel(k)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
        emptyState={
          <EmptyState
            variant="plain"
            size="sm"
            icon={Flag}
            title={status === 'OPEN' ? 'No open flags' : 'No flags'}
            description={status === 'OPEN' ? 'Nothing needs review right now.' : 'No flags match the current filters.'}
          />
        }
        renderCard={(f) => (
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-2">
              <Link href={`${routes.admin.members}/${f.user.id}/team`} className="font-medium hover:underline">
                {f.user.fullName}
              </Link>
              <StatusBadge kind="FlagStatus" value={f.status} />
            </div>
            <KindBadge kind={f.kind} />
            <button type="button" className="line-clamp-3 text-left text-sm text-muted-foreground" onClick={() => setDetail(f)}>
              {f.details}
            </button>
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <DateTime value={f.createdAt} style="date" />
              <FlagActions flag={f} />
            </div>
          </div>
        )}
      />

      <Sheet open={detail !== null} onOpenChange={(o) => !o && setDetail(null)}>
        <SheetContent className="w-full sm:max-w-md">
          {detail ? (
            <>
              <SheetHeader>
                <SheetTitle>{flagKindLabel(detail.kind)}</SheetTitle>
                <SheetDescription>
                  About {detail.user.fullName} · raised <DateTime value={detail.createdAt} />
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-4 px-4 text-sm">
                <div className="flex items-center gap-2">
                  <StatusBadge kind="FlagStatus" value={detail.status} />
                  <span className="text-muted-foreground">by {detail.createdBy?.fullName ?? 'automatic check'}</span>
                </div>
                <p className="whitespace-pre-wrap">{detail.details}</p>
                {detail.resolution ? (
                  <div className="rounded-lg bg-muted p-3">
                    <p className="text-xs text-muted-foreground">
                      {enumLabel('FlagStatus', detail.status)} by {detail.resolvedBy?.fullName ?? '—'} ·{' '}
                      <DateTime value={detail.resolvedAt} />
                    </p>
                    <p className="mt-1 whitespace-pre-wrap">{detail.resolution}</p>
                  </div>
                ) : null}
                <Button asChild variant="outline" size="sm">
                  <Link href={`${routes.admin.members}/${detail.user.id}/team`}>
                    <Network aria-hidden />
                    Open member’s network
                  </Link>
                </Button>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function FlagActions({ flag }: { flag: FlagDto }) {
  const resolve = useResolveFlag();
  const { user } = useSession();
  if (flag.status !== 'OPEN') {
    return <span className="text-xs text-muted-foreground">{flag.resolvedBy ? `by ${flag.resolvedBy.fullName}` : ''}</span>;
  }
  // The API refuses resolving a flag about yourself (separation of duties): another admin reviews it.
  if (user && flag.user.id === user.id) {
    return <span className="text-xs text-muted-foreground">About you — another admin reviews it</span>;
  }
  const run = (status: 'RESOLVED' | 'DISMISSED') => async ({ reason }: { reason?: string }) => {
    await resolve.mutateAsync({ id: flag.id, status, resolution: reason ?? '' });
    toast.success(status === 'RESOLVED' ? 'Flag resolved' : 'Flag dismissed');
  };
  return (
    <div className="flex justify-end gap-1.5">
      <ConfirmDialog
        trigger={
          <Button variant="outline" size="sm">
            <CheckCircle2 aria-hidden />
            Resolve
          </Button>
        }
        title="Resolve flag"
        description={`Record what you found about ${flag.user.fullName}. Resolving does not change any balances.`}
        reason={{ label: 'Resolution', placeholder: 'What did you check and conclude?' }}
        confirmLabel="Resolve"
        onConfirm={run('RESOLVED')}
      />
      <ConfirmDialog
        trigger={
          <Button variant="ghost" size="sm">
            <XCircle aria-hidden />
            Dismiss
          </Button>
        }
        title="Dismiss flag"
        description="Dismiss this signal as a false positive."
        reason={{ label: 'Why is this not a concern?' }}
        confirmLabel="Dismiss"
        onConfirm={run('DISMISSED')}
      />
    </div>
  );
}

