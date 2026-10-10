'use client';

import type { ColumnDef } from '@tanstack/react-table';
import type { MemberRewardDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { StatusBadge } from '@/components/app/status-badge';

import { unitFormat } from '../../../finance/lib';

/** `YYYY-MM-DD` (already a calendar date in the program's zone) → "12 Oct 2026". */
export function formatCalendarDate(value: string | null): string {
  if (!value) return '—';
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return value;
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

/** The latest decision on a reward, for the "Decision" column and mobile cards. */
export function latestDecision(r: MemberRewardDto): { label: string; date: string | null; reason: string | null } | null {
  if (r.reversedDate) return { label: 'Reversed', date: r.reversedDate, reason: r.reversalReason };
  if (r.rejectedDate) return { label: 'Rejected', date: r.rejectedDate, reason: r.rejectionReason };
  if (r.postedDate) return { label: 'Posted', date: r.postedDate, reason: null };
  if (r.approvedDate) return { label: 'Approved', date: r.approvedDate, reason: null };
  return null;
}

export const memberRewardColumns: ColumnDef<MemberRewardDto>[] = [
  {
    id: 'createdDate',
    header: 'Date',
    cell: ({ row }) => (
      <time dateTime={row.original.createdDate} className="whitespace-nowrap tabular-nums">
        {formatCalendarDate(row.original.createdDate)}
      </time>
    ),
  },
  {
    id: 'program',
    header: 'Program',
    cell: ({ row }) => <span className="font-medium">{row.original.program.name}</span>,
  },
  {
    id: 'level',
    header: 'Level',
    meta: { align: 'right' },
    cell: ({ row }) => <span className="tabular-nums">L{row.original.level}</span>,
  },
  {
    id: 'amount',
    header: 'Amount',
    meta: { align: 'right' },
    cell: ({ row }) => (
      <Amount
        value={row.original.amountMinor}
        format={unitFormat(row.original)}
        tone={row.original.status === 'REJECTED' || row.original.status === 'REVERSED' ? 'muted' : 'default'}
        className={row.original.status === 'REJECTED' || row.original.status === 'REVERSED' ? 'line-through' : 'font-medium'}
      />
    ),
  },
  {
    id: 'status',
    header: 'Status',
    cell: ({ row }) => <StatusBadge kind="RewardStatus" value={row.original.status} />,
  },
  {
    id: 'decision',
    header: 'Decision',
    cell: ({ row }) => {
      const d = latestDecision(row.original);
      if (!d) return <span className="text-muted-foreground">Awaiting review</span>;
      return (
        <div className="max-w-72 min-w-0">
          <p className="text-sm whitespace-nowrap">
            {d.label} {formatCalendarDate(d.date)}
          </p>
          {d.reason ? (
            <p className="truncate text-xs text-muted-foreground" title={d.reason}>
              {d.reason}
            </p>
          ) : null}
        </div>
      );
    },
  },
];
