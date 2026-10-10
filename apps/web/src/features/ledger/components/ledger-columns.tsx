'use client';

import type { ColumnDef } from '@tanstack/react-table';
import type { LedgerAccountDto, LedgerTransactionDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { DateTime } from '@/components/app/date-time';
import { StatusBadge } from '@/components/app/status-badge';
import { enumLabel } from '@/lib/enum-labels';

import { unitFormat } from '../../finance/lib';

export function transactionColumns(onOpen: (t: LedgerTransactionDto) => void): ColumnDef<LedgerTransactionDto>[] {
  return [
    {
      id: 'postedAt',
      header: 'Posted',
      enableHiding: false,
      cell: ({ row }) => (
        <button
          type="button"
          className="text-left hover:underline focus-visible:underline"
          onClick={() => onOpen(row.original)}
          aria-label={`Open ${enumLabel('LedgerTransactionType', row.original.type)} of ${row.original.member.fullName}`}
        >
          <DateTime value={row.original.postedAt} />
        </button>
      ),
    },
    {
      id: 'type',
      header: 'Type',
      cell: ({ row }) => <StatusBadge kind="LedgerTransactionType" value={row.original.type} />,
    },
    {
      id: 'member',
      header: 'Member',
      meta: { label: 'Member' },
      cell: ({ row }) => <span className="font-medium">{row.original.member.fullName}</span>,
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
      id: 'reward',
      header: 'Reward',
      meta: { label: 'Reward' },
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          L{row.original.reward.level} · <StatusBadge kind="RewardStatus" value={row.original.reward.status} />
        </span>
      ),
    },
    {
      id: 'amount',
      header: 'Amount',
      enableHiding: false,
      meta: { align: 'right' },
      cell: ({ row }) => (
        <Amount
          value={row.original.type === 'REWARD_REVERSAL' ? `-${row.original.amountMinor}` : row.original.amountMinor}
          format={unitFormat(row.original)}
          tone="auto"
          signed
          className="font-medium"
        />
      ),
    },
    {
      id: 'postedBy',
      header: 'Posted by',
      meta: { label: 'Posted by' },
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.postedBy?.fullName ?? 'System'}</span>,
    },
  ];
}

export const accountColumns: ColumnDef<LedgerAccountDto>[] = [
  {
    id: 'type',
    header: 'Account',
    cell: ({ row }) => (
      <div className="min-w-0">
        <p className="font-medium">{row.original.owner?.fullName ?? 'Platform'}</p>
        <p className="text-xs text-muted-foreground">{enumLabel('LedgerAccountType', row.original.type)}</p>
      </div>
    ),
  },
  {
    id: 'unit',
    header: 'Unit',
    cell: ({ row }) => (
      <span className="text-muted-foreground">{row.original.rewardUnit === 'POINTS' ? 'Points' : row.original.currencyCode}</span>
    ),
  },
  {
    id: 'debits',
    header: 'Debits',
    meta: { align: 'right' },
    cell: ({ row }) => <Amount value={row.original.debitsMinor} format={unitFormat(row.original)} tone="muted" />,
  },
  {
    id: 'credits',
    header: 'Credits',
    meta: { align: 'right' },
    cell: ({ row }) => <Amount value={row.original.creditsMinor} format={unitFormat(row.original)} tone="muted" />,
  },
  {
    id: 'balance',
    header: 'Balance',
    meta: { align: 'right' },
    cell: ({ row }) => <Amount value={row.original.balanceMinor} format={unitFormat(row.original)} tone="auto" className="font-semibold" />,
  },
];
