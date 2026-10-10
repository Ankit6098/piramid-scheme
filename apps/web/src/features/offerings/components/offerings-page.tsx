'use client';

import type { ColumnDef } from '@tanstack/react-table';
import { BadgeCheck, Ban, FilterX, MoreHorizontal, Pencil, Plus, ShoppingBag, Trash2 } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Permission, type OfferingDto, type OfferingKind, type OfferingStatus } from '@app/shared';

import { ConfirmDialog } from '@/components/app/confirm-dialog';
import { DataTable, useCursorList } from '@/components/app/data-table';
import { DateTime } from '@/components/app/date-time';
import { Can } from '@/components/app/guards';
import { PageHeader } from '@/components/app/page-header';
import { EmptyState } from '@/components/app/states';
import { StatusBadge } from '@/components/app/status-badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet } from '@/components/ui/sheet';
import { useSession } from '@/hooks/use-session';
import { enumLabel, enumOptions } from '@/lib/enum-labels';
import { queryKeys } from '@/lib/query-keys';

import { FilterSelect, SearchInput } from '@/features/programs/components/list-toolbar';
import { OFFERINGS_PATH, useApproveOffering, useDeactivateOffering, useDeleteOffering } from '../api';
import { OfferingSheetContent } from './offering-sheet';

type Dialog =
  | { kind: 'approve'; offering: OfferingDto }
  | { kind: 'deactivate'; offering: OfferingDto }
  | { kind: 'delete'; offering: OfferingDto };

/** /admin/offerings — approved products and services (create, edit, approve, deactivate). */
export function OfferingsPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<OfferingStatus | undefined>();
  const [kind, setKind] = useState<OfferingKind | undefined>();
  const query = useMemo(() => ({ q: q || undefined, status, kind }), [q, status, kind]);
  const list = useCursorList<OfferingDto>({ queryKey: queryKeys.admin.offerings(query), path: OFFERINGS_PATH, query });

  const [sheet, setSheet] = useState<{ open: boolean; offering?: OfferingDto; session: number }>({ open: false, session: 0 });
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const approve = useApproveOffering();
  const deactivate = useDeactivateOffering();
  const remove = useDeleteOffering();
  const { can } = useSession();

  const canWrite = can(Permission.OfferingsWrite);
  const canApprove = can(Permission.OfferingsApprove);
  const openSheet = useCallback(
    (offering?: OfferingDto) => setSheet((s) => ({ open: true, offering, session: s.session + 1 })),
    [],
  );
  const filtered = Boolean(q || status || kind);

  const columns = useMemo<ColumnDef<OfferingDto>[]>(
    () => [
      {
        id: 'name',
        header: 'Offering',
        cell: ({ row }) => {
          const o = row.original;
          return (
            <div className="min-w-0 max-w-sm">
              <p className="truncate font-medium">{o.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {o.sku ? <span className="font-mono">{o.sku}</span> : 'No SKU'}
                {o.description ? ` · ${o.description}` : ''}
              </p>
            </div>
          );
        },
      },
      { id: 'kind', header: 'Kind', cell: ({ row }) => enumLabel('OfferingKind', row.original.kind) },
      { id: 'status', header: 'Status', cell: ({ row }) => <StatusBadge kind="OfferingStatus" value={row.original.status} /> },
      {
        id: 'programs',
        header: 'Programs',
        meta: { align: 'right' },
        cell: ({ row }) => (
          <span className="tabular-nums" title={`${row.original.liveProgramCount} live of ${row.original.programCount}`}>
            {row.original.liveProgramCount} live / {row.original.programCount}
          </span>
        ),
      },
      {
        id: 'approved',
        header: 'Approved',
        cell: ({ row }) =>
          row.original.approvedAt ? (
            <div className="text-xs">
              <DateTime value={row.original.approvedAt} style="date" />
              <p className="text-muted-foreground">{row.original.approvedBy?.fullName ?? '—'}</p>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">Not approved</span>
          ),
      },
      {
        id: 'created',
        header: 'Created',
        cell: ({ row }) => <DateTime value={row.original.createdAt} style="date" className="text-xs" />,
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        meta: { align: 'right' },
        cell: ({ row }) => <RowActions offering={row.original} onEdit={openSheet} onDialog={setDialog} canWrite={canWrite} canApprove={canApprove} />,
      },
    ],
    [canWrite, canApprove, openSheet],
  );

  const newButton = (
    <Can perm={Permission.OfferingsWrite}>
      <Button onClick={() => openSheet()}>
        <Plus aria-hidden />
        New offering
      </Button>
    </Can>
  );

  return (
    <div>
      <PageHeader
        title="Offerings"
        description="Products and services sold to end customers. Programs are built on an offering, and rewards only ever come from qualifying sales of approved (active) offerings."
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
        caption="Offerings"
        toolbar={
          <>
            <SearchInput value={q} onChange={setQ} placeholder="Search name or SKU" />
            <FilterSelect label="Status" value={status} allLabel="All statuses" options={enumOptions('OfferingStatus')} onChange={(v) => setStatus(v as OfferingStatus | undefined)} />
            <FilterSelect label="Kind" value={kind} allLabel="All kinds" options={enumOptions('OfferingKind')} onChange={(v) => setKind(v as OfferingKind | undefined)} />
          </>
        }
        emptyState={
          filtered ? (
            <EmptyState
              variant="plain"
              size="sm"
              icon={FilterX}
              title="No offerings match these filters"
              action={
                <Button
                  variant="outline"
                  onClick={() => {
                    setQ('');
                    setStatus(undefined);
                    setKind(undefined);
                  }}
                >
                  Reset filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              variant="plain"
              icon={ShoppingBag}
              title="No offerings yet"
              description="Add the products or services your programs are built around. Each one needs approval before it can be used."
              action={newButton}
            />
          )
        }
        renderCard={(o) => (
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-medium">{o.name}</p>
                <p className="text-xs text-muted-foreground">
                  {enumLabel('OfferingKind', o.kind)}
                  {o.sku ? ` · ${o.sku}` : ''}
                </p>
              </div>
              <RowActions offering={o} onEdit={openSheet} onDialog={setDialog} canWrite={canWrite} canApprove={canApprove} />
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <StatusBadge kind="OfferingStatus" value={o.status} />
              <span>
                {o.liveProgramCount} live / {o.programCount} programs
              </span>
            </div>
          </div>
        )}
      />

      <Sheet open={sheet.open} onOpenChange={(open) => setSheet((s) => ({ ...s, open }))}>
        {sheet.open ? (
          <OfferingSheetContent key={sheet.session} offering={sheet.offering} onDone={() => setSheet((s) => ({ ...s, open: false }))} />
        ) : null}
      </Sheet>

      <ConfirmDialog
        open={dialog?.kind === 'approve'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Approve “${dialog?.offering.name ?? ''}”?`}
        description="Approved offerings can back published programs, and their sales can be recorded as qualifying events."
        confirmLabel="Approve offering"
        reason={{ required: false, label: 'Note (optional)' }}
        onConfirm={async ({ reason }) => {
          if (dialog?.kind !== 'approve') return;
          await approve.mutateAsync({ id: dialog.offering.id, reason });
          toast.success('Offering approved');
        }}
      />
      <ConfirmDialog
        open={dialog?.kind === 'deactivate'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Deactivate “${dialog?.offering.name ?? ''}”?`}
        description={
          dialog?.offering.liveProgramCount
            ? `${dialog.offering.liveProgramCount} live program(s) use this offering. While it is inactive, no new sales can be recorded for them and draft programs can't be published with it.`
            : "While inactive, it can't back a program publication and its sales can't be recorded."
        }
        confirmLabel="Deactivate"
        variant="destructive"
        reason
        onConfirm={async ({ reason }) => {
          if (dialog?.kind !== 'deactivate' || !reason) return;
          await deactivate.mutateAsync({ id: dialog.offering.id, reason });
          toast.success('Offering deactivated');
        }}
      />
      <ConfirmDialog
        open={dialog?.kind === 'delete'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Delete “${dialog?.offering.name ?? ''}”?`}
        description="This permanently removes the offering. Only inactive offerings that no program or sale uses can be deleted."
        confirmLabel="Delete offering"
        variant="destructive"
        onConfirm={async () => {
          if (dialog?.kind !== 'delete') return;
          await remove.mutateAsync(dialog.offering.id);
          toast.success('Offering deleted');
        }}
      />
    </div>
  );
}

function RowActions({
  offering,
  onEdit,
  onDialog,
  canWrite,
  canApprove,
}: {
  offering: OfferingDto;
  onEdit: (o: OfferingDto) => void;
  onDialog: (d: Dialog) => void;
  canWrite: boolean;
  canApprove: boolean;
}) {
  const active = offering.status === 'ACTIVE';
  const canEdit = canWrite && (!active || canApprove);
  const canDelete = canWrite && !active && offering.programCount === 0;
  if (!canEdit && !canApprove && !canDelete) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${offering.name}`}>
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="truncate">{offering.name}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {canEdit ? (
          <DropdownMenuItem onSelect={() => onEdit(offering)}>
            <Pencil aria-hidden />
            Edit
          </DropdownMenuItem>
        ) : null}
        {canApprove && !active ? (
          <DropdownMenuItem onSelect={() => onDialog({ kind: 'approve', offering })}>
            <BadgeCheck aria-hidden />
            Approve
          </DropdownMenuItem>
        ) : null}
        {canApprove && active ? (
          <DropdownMenuItem onSelect={() => onDialog({ kind: 'deactivate', offering })}>
            <Ban aria-hidden />
            Deactivate
          </DropdownMenuItem>
        ) : null}
        {canDelete ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => onDialog({ kind: 'delete', offering })}>
              <Trash2 aria-hidden />
              Delete
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
