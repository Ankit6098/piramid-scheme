'use client';

import type { ColumnDef } from '@tanstack/react-table';
import { Ban, Info, Layers, Lock, MoreHorizontal, Pencil, Plus, RotateCcw } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Permission, type AdminProgramDetailDto, type ProgramOptionDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { ConfirmDialog } from '@/components/app/confirm-dialog';
import { DataTable } from '@/components/app/data-table';
import { SectionHeader } from '@/components/app/page-header';
import { EmptyState } from '@/components/app/states';
import { ToneBadge } from '@/components/app/status-badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSession } from '@/hooks/use-session';
import { getErrorMessage } from '@/lib/api-client';
import { enumLabel } from '@/lib/enum-labels';

import { useAdminProgram, useSetOptionActive } from '../../api';
import { OptionDialogContent } from './option-dialog';

/** /admin/programs/[id]/options — the plans members can enroll in. */
export function ProgramOptionsTab() {
  const { id } = useParams<{ id: string }>();
  const { data: program } = useAdminProgram(id);
  if (!program) return null;
  return <OptionsTable program={program} />;
}

function OptionsTable({ program }: { program: AdminProgramDetailDto }) {
  const { can } = useSession();
  const canWrite = can(Permission.ProgramsWrite) && program.status !== 'ARCHIVED';
  const canAdd = canWrite && program.status !== 'COMPLETED';
  const [dialog, setDialog] = useState<{ open: boolean; option?: ProgramOptionDto; session: number }>({ open: false, session: 0 });
  const [deactivating, setDeactivating] = useState<ProgramOptionDto | null>(null);
  const setActive = useSetOptionActive(program.id);
  const live = ['SCHEDULED', 'ACTIVE', 'PAUSED'].includes(program.status);
  const currency = useMemo(
    () => ({ currencyCode: program.currencyCode, minorUnits: program.currencyMinorUnits }),
    [program.currencyCode, program.currencyMinorUnits],
  );

  const openDialog = useCallback((option?: ProgramOptionDto) => setDialog((d) => ({ open: true, option, session: d.session + 1 })), []);
  const reactivate = useCallback(
    async (option: ProgramOptionDto) => {
      try {
        await setActive.mutateAsync({ optionId: option.id, active: true });
        toast.success(`“${option.name}” is available again`);
      } catch (error) {
        toast.error(getErrorMessage(error));
      }
    },
    [setActive],
  );

  const columns = useMemo<ColumnDef<ProgramOptionDto>[]>(
    () => [
      {
        id: 'name',
        header: 'Option',
        cell: ({ row }) => (
          <div className="min-w-0 max-w-sm">
            <p className="flex items-center gap-1.5 truncate font-medium">
              {row.original.name}
              {row.original.termsLocked ? (
                <Lock className="size-3 text-muted-foreground" aria-label="Price, billing and duration locked" />
              ) : null}
            </p>
            {row.original.description ? <p className="truncate text-xs text-muted-foreground">{row.original.description}</p> : null}
          </div>
        ),
      },
      {
        id: 'price',
        header: 'Price',
        meta: { align: 'right' },
        cell: ({ row }) =>
          row.original.priceMinor === '0' ? (
            <span className="text-sm">Free</span>
          ) : (
            <Amount kind="currency" value={row.original.priceMinor} format={currency} />
          ),
      },
      {
        id: 'billing',
        header: 'Billing',
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-sm">
            {enumLabel('BillingFrequency', row.original.billingFrequency)} · {row.original.durationDays} days
          </span>
        ),
      },
      { id: 'renewal', header: 'Renewal', cell: ({ row }) => enumLabel('RenewalPolicy', row.original.renewalPolicy) },
      {
        id: 'enrollments',
        header: 'Enrollments',
        meta: { align: 'right' },
        cell: ({ row }) => <span className="tabular-nums">{row.original.enrollmentCount}</span>,
      },
      {
        id: 'status',
        header: 'Status',
        cell: ({ row }) => <ToneBadge tone={row.original.isActive ? 'success' : 'muted'}>{row.original.isActive ? 'Available' : 'Inactive'}</ToneBadge>,
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        meta: { align: 'right' },
        cell: ({ row }) =>
          canWrite ? (
            <OptionActions option={row.original} onEdit={openDialog} onDeactivate={setDeactivating} onActivate={reactivate} />
          ) : null,
      },
    ],
    [canWrite, openDialog, reactivate, currency],
  );

  const addButton = canAdd ? (
    <Button onClick={() => openDialog()}>
      <Plus aria-hidden />
      Add option
    </Button>
  ) : null;

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Options"
        description={`Plans members enroll in. Prices are in ${program.currencyCode} and pay for access to ${program.offering.name}.`}
        actions={addButton}
      />
      <p className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Option prices are what members pay for the plan itself — never an investment, and never a reward trigger. Rewards come only from
        qualifying sales of the offering to end customers.
      </p>
      <DataTable
        columns={columns}
        data={program.options}
        caption="Program options"
        emptyState={
          <EmptyState
            variant="plain"
            icon={Layers}
            title="No options yet"
            description="Add at least one plan before publishing — for example a monthly and a yearly plan, or a free plan."
            action={addButton}
          />
        }
        renderCard={(o) => (
          <div className="space-y-1.5">
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 truncate font-medium">{o.name}</p>
              {canWrite ? <OptionActions option={o} onEdit={openDialog} onDeactivate={setDeactivating} onActivate={reactivate} /> : null}
            </div>
            <p className="text-sm">
              {o.priceMinor === '0' ? 'Free' : <Amount kind="currency" value={o.priceMinor} format={currency} />} ·{' '}
              {enumLabel('BillingFrequency', o.billingFrequency)} · {o.durationDays} days
            </p>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ToneBadge tone={o.isActive ? 'success' : 'muted'}>{o.isActive ? 'Available' : 'Inactive'}</ToneBadge>
              {o.enrollmentCount} enrollments
            </div>
          </div>
        )}
      />

      <Dialog open={dialog.open} onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}>
        {dialog.open ? (
          <OptionDialogContent
            key={dialog.session}
            program={program}
            option={dialog.option}
            onDone={() => setDialog((d) => ({ ...d, open: false }))}
          />
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={deactivating !== null}
        onOpenChange={(open) => !open && setDeactivating(null)}
        title={`Deactivate “${deactivating?.name ?? ''}”?`}
        description={
          live
            ? 'Members can no longer choose this plan. Existing enrollments are not affected. A published program needs at least one available option.'
            : 'Members will not be able to choose this plan. Existing enrollments are not affected.'
        }
        confirmLabel="Deactivate option"
        variant="destructive"
        onConfirm={async () => {
          if (!deactivating) return;
          await setActive.mutateAsync({ optionId: deactivating.id, active: false });
          toast.success('Option deactivated');
        }}
      />
    </div>
  );
}

function OptionActions({
  option,
  onEdit,
  onDeactivate,
  onActivate,
}: {
  option: ProgramOptionDto;
  onEdit: (o: ProgramOptionDto) => void;
  onDeactivate: (o: ProgramOptionDto) => void;
  onActivate: (o: ProgramOptionDto) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${option.name}`}>
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onEdit(option)}>
          <Pencil aria-hidden />
          Edit
        </DropdownMenuItem>
        {option.isActive ? (
          <DropdownMenuItem variant="destructive" onSelect={() => onDeactivate(option)}>
            <Ban aria-hidden />
            Deactivate
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => onActivate(option)}>
            <RotateCcw aria-hidden />
            Make available
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
