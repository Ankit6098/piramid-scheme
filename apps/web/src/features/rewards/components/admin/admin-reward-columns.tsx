'use client';

import type { ColumnDef } from '@tanstack/react-table';
import { Check, MoreHorizontal, ShieldAlert, Undo2, X } from 'lucide-react';
import type { AdminRewardRowDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { DateTime } from '@/components/app/date-time';
import { StatusBadge } from '@/components/app/status-badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import { currencyFormat, unitFormat } from '../../../finance/lib';
import type { RewardDecisionKind } from './reward-decision-dialog';

export interface RewardPermissions {
  approve: boolean;
  reverse: boolean;
  reverseEvent: boolean;
}

/** Why the viewer may not approve this reward (segregation of duties), or null. */
export function approvalBlocker(r: AdminRewardRowDto): string | null {
  if (r.viewer.isRecipient) return 'This reward is credited to you — another reviewer must decide on it.';
  if (r.viewer.recordedSale) return 'You recorded this sale — another reviewer must approve its rewards.';
  return null;
}

export function isPending(r: AdminRewardRowDto): boolean {
  return r.status === 'PENDING_APPROVAL' || r.status === 'APPROVED';
}

/** Rows the viewer may select for bulk approval. */
export function isSelectable(r: AdminRewardRowDto, perms: RewardPermissions): boolean {
  return perms.approve && isPending(r) && approvalBlocker(r) === null;
}

export interface AdminRewardColumnsOptions {
  perms: RewardPermissions;
  selected: ReadonlySet<string>;
  onToggle: (id: string, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
  allSelected: boolean;
  someSelected: boolean;
  selectable: boolean;
  onOpen: (r: AdminRewardRowDto) => void;
  onDecide: (r: AdminRewardRowDto, kind: RewardDecisionKind) => void;
}

export function adminRewardColumns(o: AdminRewardColumnsOptions): ColumnDef<AdminRewardRowDto>[] {
  const columns: ColumnDef<AdminRewardRowDto>[] = [];
  if (o.selectable) {
    columns.push({
      id: 'select',
      enableHiding: false,
      header: () => (
        <Checkbox
          checked={o.allSelected ? true : o.someSelected ? 'indeterminate' : false}
          onCheckedChange={(v) => o.onToggleAll(v === true)}
          aria-label="Select all approvable rewards on this page"
        />
      ),
      cell: ({ row }) =>
        isSelectable(row.original, o.perms) ? (
          <Checkbox
            checked={o.selected.has(row.original.id)}
            onCheckedChange={(v) => o.onToggle(row.original.id, v === true)}
            aria-label={`Select reward for ${row.original.recipient.fullName}`}
          />
        ) : null,
      meta: { headerClassName: 'w-10', cellClassName: 'w-10' },
    });
  }
  columns.push(
    {
      id: 'createdAt',
      header: 'Created',
      meta: { label: 'Created' },
      cell: ({ row }) => <DateTime value={row.original.createdAt} style="datetime" className="text-muted-foreground" />,
    },
    {
      id: 'recipient',
      header: 'Recipient',
      enableHiding: false,
      cell: ({ row }) => (
        <div className="min-w-0">
          <button
            type="button"
            className="max-w-56 truncate text-left font-medium text-foreground hover:underline focus-visible:underline"
            onClick={() => o.onOpen(row.original)}
          >
            {row.original.recipient.fullName}
          </button>
          {row.original.viewer.isRecipient ? <p className="text-xs text-muted-foreground">You</p> : null}
        </div>
      ),
    },
    {
      id: 'program',
      header: 'Program',
      meta: { label: 'Program' },
      cell: ({ row }) => (
        <span className="block max-w-48 truncate" title={row.original.program.name}>
          {row.original.program.name}
        </span>
      ),
    },
    {
      id: 'level',
      header: 'Level',
      meta: { align: 'right', label: 'Level' },
      cell: ({ row }) => <span className="tabular-nums">L{row.original.level}</span>,
    },
    {
      id: 'amount',
      header: 'Amount',
      enableHiding: false,
      meta: { align: 'right' },
      cell: ({ row }) => <Amount value={row.original.amountMinor} format={unitFormat(row.original)} className="font-medium" />,
    },
    {
      id: 'sale',
      header: 'Sale',
      meta: { label: 'Sale' },
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="max-w-40 truncate font-mono text-xs" title={row.original.event.externalId}>
            {row.original.event.externalId}
          </p>
          <p className="text-xs text-muted-foreground">
            <Amount
              kind="currency"
              value={row.original.event.amountMinor}
              format={currencyFormat(row.original.event.currencyCode, row.original.currencyMinorUnits)}
            />{' '}
            · {row.original.event.subject.fullName}
          </p>
        </div>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      enableHiding: false,
      cell: ({ row }) => (
        <div className="flex items-center gap-1.5">
          <StatusBadge kind="RewardStatus" value={row.original.status} />
          {row.original.event.status === 'REVERSED' ? <StatusBadge kind="QualifyingEventStatus" value="REVERSED" label="Sale reversed" /> : null}
        </div>
      ),
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      enableHiding: false,
      meta: { align: 'right' },
      cell: ({ row }) => <RowActions reward={row.original} o={o} />,
    },
  );
  return columns;
}

function RowActions({ reward, o }: { reward: AdminRewardRowDto; o: AdminRewardColumnsOptions }) {
  const blocker = approvalBlocker(reward);
  const pending = isPending(reward);
  const canReject = o.perms.approve && pending && !reward.viewer.isRecipient;
  const canReverse = o.perms.reverse && reward.status === 'POSTED' && !reward.viewer.isRecipient;
  const canReverseEvent = o.perms.reverseEvent && reward.event.status === 'PROCESSED';

  return (
    <div className="flex items-center justify-end gap-1">
      {o.perms.approve && pending ? (
        blocker ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="inline-flex" aria-label={blocker}>
                <Button size="sm" variant="outline" disabled>
                  <ShieldAlert aria-hidden />
                  Approve
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-60">{blocker}</TooltipContent>
          </Tooltip>
        ) : (
          <Button size="sm" variant="outline" onClick={() => o.onDecide(reward, 'approve')}>
            <Check aria-hidden />
            Approve
          </Button>
        )
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label={`More actions for ${reward.recipient.fullName}`}>
            <MoreHorizontal aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onSelect={() => o.onOpen(reward)}>View details</DropdownMenuItem>
          {canReject || canReverse || canReverseEvent ? <DropdownMenuSeparator /> : null}
          {canReject ? (
            <DropdownMenuItem variant="destructive" onSelect={() => o.onDecide(reward, 'reject')}>
              <X aria-hidden />
              Reject…
            </DropdownMenuItem>
          ) : null}
          {canReverse ? (
            <DropdownMenuItem variant="destructive" onSelect={() => o.onDecide(reward, 'reverse')}>
              <Undo2 aria-hidden />
              Reverse reward…
            </DropdownMenuItem>
          ) : null}
          {canReverseEvent ? (
            <DropdownMenuItem variant="destructive" onSelect={() => o.onDecide(reward, 'reverse-event')}>
              <Undo2 aria-hidden />
              Reverse whole sale…
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
