'use client';

import type { ColumnDef } from '@tanstack/react-table';
import { KeyRound } from 'lucide-react';
import Link from 'next/link';
import type { SaleEventDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { DateTime } from '@/components/app/date-time';
import { StatusBadge, ToneBadge } from '@/components/app/status-badge';
import { enumLabel } from '@/lib/enum-labels';

import { outcomeMeta, pluralize, programCurrencyFormat, programRewardFormat } from '../labels';

export function RevisionBadge({ revision }: { revision: number }) {
  if (revision <= 0) return null;
  return (
    <ToneBadge tone="muted" dot={false} title={`Revision ${revision} of this sale`}>
      rev {revision}
    </ToneBadge>
  );
}

/** Short status explanation under the badge (only when it adds information). */
export function EventStatusDetail({ event }: { event: SaleEventDto }) {
  if (event.status === 'REJECTED' && event.rejectionReason) {
    return (
      <p
        className="max-w-56 truncate text-xs text-muted-foreground"
        title={event.rejectionReason}
      >
        {event.rejectionReason}
      </p>
    );
  }
  if (event.status === 'PROCESSED' || event.status === 'RECEIVED') {
    return <p className="text-xs text-muted-foreground">{outcomeMeta(event.outcome).label}</p>;
  }
  return null;
}

export function RecordedBy({ event }: { event: SaleEventDto }) {
  if (event.apiClient) {
    return (
      <span className="inline-flex min-w-0 flex-col">
        <span className="inline-flex items-center gap-1 truncate">
          <KeyRound className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{event.apiClient.name}</span>
        </span>
        <span className="font-mono text-xs text-muted-foreground">
          {event.apiClient.keyPrefix}…
        </span>
      </span>
    );
  }
  if (event.recordedBy) return <span className="truncate">{event.recordedBy.fullName}</span>;
  return <span className="text-muted-foreground">{enumLabel('QualifyingEventSource', event.source)}</span>;
}

export function RewardsCell({ event }: { event: SaleEventDto }) {
  if (event.rewardCount === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex flex-col items-end">
      <Amount value={event.rewardTotalMinor} format={programRewardFormat(event.program)} />
      <span className="text-xs text-muted-foreground">{pluralize(event.rewardCount, 'reward')}</span>
    </span>
  );
}

export interface EventColumnsOptions {
  /** Href that opens the sale in the detail drawer (keeps filters). */
  eventHref: (id: string) => string;
}

export function buildEventColumns({ eventHref }: EventColumnsOptions): ColumnDef<SaleEventDto>[] {
  return [
    {
      id: 'occurredAt',
      header: 'Occurred',
      enableHiding: false,
      cell: ({ row }) => (
        <DateTime value={row.original.occurredAt} timeZone={row.original.program.timezone} />
      ),
    },
    {
      id: 'program',
      header: 'Program',
      meta: { label: 'Program' },
      cell: ({ row }) => (
        <span className="flex min-w-0 flex-col">
          <span className="max-w-44 truncate" title={row.original.program.name}>
            {row.original.program.name}
          </span>
          <span className="font-mono text-xs text-muted-foreground">
            {row.original.program.code}
          </span>
        </span>
      ),
    },
    {
      id: 'externalId',
      header: 'External id',
      enableHiding: false,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Link
            href={eventHref(row.original.id)}
            replace
            scroll={false}
            className="max-w-48 truncate font-mono text-sm font-medium text-primary underline-offset-4 hover:underline"
            title={`Open sale ${row.original.externalId}`}
          >
            {row.original.externalId}
          </Link>
          <RevisionBadge revision={row.original.revision} />
        </span>
      ),
    },
    {
      id: 'type',
      header: 'Type',
      meta: { label: 'Sale type' },
      cell: ({ row }) => enumLabel('QualifyingEventType', row.original.type),
    },
    {
      id: 'source',
      header: 'Source',
      meta: { label: 'Source' },
      cell: ({ row }) => enumLabel('QualifyingEventSource', row.original.source),
    },
    {
      id: 'member',
      header: 'Member',
      meta: { label: 'Member' },
      cell: ({ row }) => (
        <span className="block max-w-40 truncate" title={row.original.subject.fullName}>
          {row.original.subject.fullName}
        </span>
      ),
    },
    {
      id: 'amount',
      header: 'Amount',
      enableHiding: false,
      meta: { align: 'right', label: 'Amount' },
      cell: ({ row }) => (
        <Amount
          kind="currency"
          value={row.original.amountMinor}
          format={programCurrencyFormat(row.original.program, row.original.currencyCode)}
          className="font-medium"
        />
      ),
    },
    {
      id: 'status',
      header: 'Status',
      enableHiding: false,
      cell: ({ row }) => (
        <span className="flex flex-col gap-0.5">
          <StatusBadge kind="QualifyingEventStatus" value={row.original.status} />
          <EventStatusDetail event={row.original} />
        </span>
      ),
    },
    {
      id: 'rewards',
      header: 'Rewards',
      meta: { align: 'right', label: 'Rewards' },
      cell: ({ row }) => <RewardsCell event={row.original} />,
    },
    {
      id: 'recordedBy',
      header: 'Recorded by',
      meta: { label: 'Recorded by' },
      cell: ({ row }) => <RecordedBy event={row.original} />,
    },
  ];
}

/** Mobile card (below `md`). The primary line is a real link for keyboard users. */
export function EventCard({ event, href }: { event: SaleEventDto; href: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <Link
            href={href}
            replace
            scroll={false}
            className="truncate font-mono text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {event.externalId}
          </Link>
          <RevisionBadge revision={event.revision} />
        </span>
        <StatusBadge kind="QualifyingEventStatus" value={event.status} />
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-sm">
          {event.subject.fullName}
          <span className="text-muted-foreground"> · {event.program.name}</span>
        </span>
        <Amount
          kind="currency"
          value={event.amountMinor}
          format={programCurrencyFormat(event.program, event.currencyCode)}
          className="font-medium"
        />
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <DateTime value={event.occurredAt} timeZone={event.program.timezone} />
        <span>
          {event.rewardCount > 0 ? (
            <>
              {pluralize(event.rewardCount, 'reward')} ·{' '}
              <Amount value={event.rewardTotalMinor} format={programRewardFormat(event.program)} />
            </>
          ) : (
            outcomeMeta(event.outcome).label
          )}
        </span>
      </div>
    </div>
  );
}
