'use client';

import type { ColumnDef } from '@tanstack/react-table';
import { BadgeCheck, ClipboardCheck, FilterX, MoreHorizontal, XCircle, Ban } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { EnrollmentStatus, type AdminEnrollmentDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { ConfirmDialog } from '@/components/app/confirm-dialog';
import { DataTable, useCursorList } from '@/components/app/data-table';
import { DateTime } from '@/components/app/date-time';
import { EmptyState } from '@/components/app/states';
import { StatusBadge, ToneBadge } from '@/components/app/status-badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { enumLabel } from '@/lib/enum-labels';
import { queryKeys } from '@/lib/query-keys';

import { FilterSelect, SearchInput } from '@/features/programs/components/list-toolbar';
import { ADMIN_ENROLLMENTS_PATH, useAdminCancelEnrollment, useRejectEnrollment } from '../api';
import { ActivateEnrollmentDialogContent } from './activate-enrollment-dialog';

const ALL = 'ALL';
export type StatusFilter = EnrollmentStatus | typeof ALL;

/** `?status=` value → filter (`undefined` when missing or unknown). */
export function parseStatusFilter(value: string | null | undefined): StatusFilter | undefined {
  if (value === ALL) return ALL;
  return EnrollmentStatus.find((s) => s === value);
}

export interface AdminEnrollmentsTableProps {
  /** Restrict to one program (program detail tab); hides the program column and filter. */
  programId?: string;
  /** Programs offered in the program filter (queue page). */
  programOptions?: readonly { value: string; label: string }[];
  defaultStatus?: StatusFilter;
  /** Controlled status filter (e.g. kept in the URL); uncontrolled (starting at `defaultStatus`) when omitted. */
  status?: StatusFilter;
  onStatusChange?: (status: StatusFilter) => void;
}

type Decision = { kind: 'reject' | 'cancel'; enrollment: AdminEnrollmentDto };

/** Enrollment list with activation (payment), rejection and cancellation. Scoped by the API. */
export function AdminEnrollmentsTable({
  programId,
  programOptions,
  defaultStatus = 'PENDING',
  status: controlledStatus,
  onStatusChange,
}: AdminEnrollmentsTableProps) {
  const [localStatus, setLocalStatus] = useState<StatusFilter>(defaultStatus);
  const status = controlledStatus ?? localStatus;
  const setStatus = (next: StatusFilter) => (onStatusChange ? onStatusChange(next) : setLocalStatus(next));
  const [q, setQ] = useState('');
  const [program, setProgram] = useState<string | undefined>(programId);
  const query = useMemo(
    () => ({ status: status === ALL ? undefined : status, q: q || undefined, programId: programId ?? program }),
    [status, q, programId, program],
  );
  const list = useCursorList<AdminEnrollmentDto>({ queryKey: queryKeys.admin.enrollments(query), path: ADMIN_ENROLLMENTS_PATH, query });

  const [activating, setActivating] = useState<{ enrollment: AdminEnrollmentDto; session: number } | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const reject = useRejectEnrollment();
  const cancel = useAdminCancelEnrollment();
  const openActivate = useCallback((enrollment: AdminEnrollmentDto) => setActivating((a) => ({ enrollment, session: (a?.session ?? 0) + 1 })), []);

  const columns = useMemo<ColumnDef<AdminEnrollmentDto>[]>(() => {
    const cols: ColumnDef<AdminEnrollmentDto>[] = [
      {
        id: 'member',
        header: 'Member',
        cell: ({ row }) => (
          <div className="min-w-0 max-w-56">
            <p className="truncate font-medium">{row.original.member.fullName}</p>
            <p className="truncate text-xs text-muted-foreground">{row.original.member.email}</p>
          </div>
        ),
      },
    ];
    if (!programId) {
      cols.push({
        id: 'program',
        header: 'Program',
        cell: ({ row }) => (
          <Link href={`/admin/programs/${row.original.program.id}`} className="block max-w-48 truncate hover:underline">
            {row.original.program.name}
          </Link>
        ),
      });
    }
    cols.push(
      {
        id: 'plan',
        header: 'Plan',
        cell: ({ row }) => {
          const e = row.original;
          return (
            <div className="min-w-0">
              <p className="truncate">{e.option.name}</p>
              <p className="text-xs text-muted-foreground">
                {e.option.priceMinor === '0' ? (
                  'Free'
                ) : (
                  <Amount
                    kind="currency"
                    value={e.option.priceMinor}
                    format={{ currencyCode: e.program.currencyCode, minorUnits: e.program.currencyMinorUnits }}
                  />
                )}{' '}
                · {enumLabel('BillingFrequency', e.option.billingFrequency)}
              </p>
            </div>
          );
        },
      },
      {
        id: 'status',
        header: 'Status',
        cell: ({ row }) => (
          <div className="flex flex-wrap items-center gap-1">
            <StatusBadge kind="EnrollmentStatus" value={row.original.status} />
            {row.original.upcoming ? <ToneBadge tone="info">Renewal queued</ToneBadge> : null}
          </div>
        ),
      },
      {
        id: 'coverage',
        header: 'Coverage',
        cell: ({ row }) => <Coverage e={row.original} />,
      },
      {
        id: 'payment',
        header: 'Payment',
        cell: ({ row }) =>
          row.original.paymentReference ? (
            <div className="text-xs">
              <p className="font-mono">{row.original.paymentReference}</p>
              <Amount
                kind="currency"
                value={row.original.paymentAmountMinor}
                format={{ currencyCode: row.original.program.currencyCode, minorUnits: row.original.program.currencyMinorUnits }}
                className="text-muted-foreground"
              />
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      },
      {
        id: 'created',
        header: 'Requested',
        cell: ({ row }) => <DateTime value={row.original.createdAt} timeZone={row.original.program.timezone} className="text-xs" />,
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        meta: { align: 'right' },
        cell: ({ row }) => <EnrollmentActions e={row.original} onActivate={openActivate} onDecision={setDecision} />,
      },
    );
    return cols;
  }, [programId, openActivate]);

  const filtered = Boolean(q) || (!programId && Boolean(program)) || status !== defaultStatus;

  return (
    <>
      <DataTable
        columns={columns}
        data={list.rows}
        isLoading={list.isLoading}
        isFetching={list.isFetching}
        error={list.error}
        onRetry={list.refetch}
        pagination={list.pagination}
        caption="Enrollments"
        toolbar={
          <>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={status}
              onValueChange={(v) => v && setStatus(v as StatusFilter)}
              aria-label="Filter by status"
              className="flex-wrap"
            >
              {EnrollmentStatus.map((s) => (
                <ToggleGroupItem key={s} value={s}>
                  {enumLabel('EnrollmentStatus', s)}
                </ToggleGroupItem>
              ))}
              <ToggleGroupItem value={ALL}>All</ToggleGroupItem>
            </ToggleGroup>
            <SearchInput value={q} onChange={setQ} placeholder="Search member or payment ref" />
            {!programId && programOptions ? (
              <FilterSelect label="Program" value={program} allLabel="All programs" options={programOptions} onChange={setProgram} className="w-full sm:w-52" />
            ) : null}
          </>
        }
        emptyState={
          filtered ? (
            <EmptyState
              variant="plain"
              size="sm"
              icon={FilterX}
              title="No enrollments match these filters"
              action={
                <Button
                  variant="outline"
                  onClick={() => {
                    setQ('');
                    setStatus(defaultStatus);
                    if (!programId) setProgram(undefined);
                  }}
                >
                  Reset filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              variant="plain"
              icon={ClipboardCheck}
              title={status === 'PENDING' ? 'Nothing waiting for activation' : 'No enrollments yet'}
              description={
                status === 'PENDING'
                  ? 'Paid plans appear here until you record the member’s offline payment. Free plans activate automatically.'
                  : 'Members’ enrollments in your programs appear here.'
              }
            />
          )
        }
        renderCard={(e) => (
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-medium">{e.member.fullName}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {programId ? '' : `${e.program.name} · `}
                  {e.option.name}
                </p>
              </div>
              <EnrollmentActions e={e} onActivate={openActivate} onDecision={setDecision} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge kind="EnrollmentStatus" value={e.status} />
              {e.upcoming ? <ToneBadge tone="info">Renewal queued</ToneBadge> : null}
            </div>
            <Coverage e={e} />
          </div>
        )}
      />

      <Dialog open={activating !== null} onOpenChange={(open) => !open && setActivating(null)}>
        {activating ? (
          <ActivateEnrollmentDialogContent key={activating.session} enrollment={activating.enrollment} onDone={() => setActivating(null)} />
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={decision?.kind === 'reject'}
        onOpenChange={(open) => !open && setDecision(null)}
        title="Reject this enrollment?"
        description={decision ? `${decision.enrollment.member.fullName} will be told the enrollment in ${decision.enrollment.program.name} was not approved, with your reason.` : undefined}
        confirmLabel="Reject enrollment"
        variant="destructive"
        reason={{ label: 'Reason (shared with the member)' }}
        onConfirm={async ({ reason }) => {
          if (decision?.kind !== 'reject' || !reason) return;
          await reject.mutateAsync({ id: decision.enrollment.id, reason });
          toast.success('Enrollment rejected');
        }}
      />
      <ConfirmDialog
        open={decision?.kind === 'cancel'}
        onOpenChange={(open) => !open && setDecision(null)}
        title="Cancel this enrollment?"
        description={
          decision?.enrollment.status === 'ACTIVE'
            ? 'Coverage ends now (a queued renewal is withdrawn). Rewards already earned are not affected. The member is notified.'
            : 'The pending enrollment is withdrawn and the member is notified.'
        }
        confirmLabel="Cancel enrollment"
        cancelLabel="Keep it"
        variant="destructive"
        reason={{ label: 'Reason (shared with the member)' }}
        onConfirm={async ({ reason }) => {
          if (decision?.kind !== 'cancel' || !reason) return;
          await cancel.mutateAsync({ id: decision.enrollment.id, reason });
          toast.success('Enrollment cancelled');
        }}
      />
    </>
  );
}

function Coverage({ e }: { e: AdminEnrollmentDto }) {
  if (!e.effectiveFrom || !e.effectiveTo) return <span className="text-xs text-muted-foreground">Not started</span>;
  const empty = e.effectiveFrom === e.effectiveTo;
  if (empty) return <span className="text-xs text-muted-foreground">Withdrawn before start</span>;
  return (
    <span className="text-xs whitespace-nowrap">
      <DateTime value={e.effectiveFrom} timeZone={e.program.timezone} style="date" />
      <span className="text-muted-foreground"> → </span>
      <DateTime value={e.effectiveTo} timeZone={e.program.timezone} style="date" />
    </span>
  );
}

function EnrollmentActions({
  e,
  onActivate,
  onDecision,
}: {
  e: AdminEnrollmentDto;
  onActivate: (e: AdminEnrollmentDto) => void;
  onDecision: (d: Decision) => void;
}) {
  if (e.allowedActions.length === 0) return null;
  const canActivate = e.allowedActions.includes('activate');
  return (
    <div className="flex items-center justify-end gap-1">
      {canActivate ? (
        <Button size="sm" onClick={() => onActivate(e)}>
          <BadgeCheck aria-hidden />
          Activate
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${e.member.fullName}`}>
            <MoreHorizontal aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {e.allowedActions.includes('reject') ? (
            <DropdownMenuItem variant="destructive" onSelect={() => onDecision({ kind: 'reject', enrollment: e })}>
              <XCircle aria-hidden />
              Reject
            </DropdownMenuItem>
          ) : null}
          {e.allowedActions.includes('reject') && e.allowedActions.includes('cancel') ? <DropdownMenuSeparator /> : null}
          {e.allowedActions.includes('cancel') ? (
            <DropdownMenuItem variant="destructive" onSelect={() => onDecision({ kind: 'cancel', enrollment: e })}>
              <Ban aria-hidden />
              Cancel enrollment
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
