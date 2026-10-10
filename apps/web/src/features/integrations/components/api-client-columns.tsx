'use client';

import type { ColumnDef } from '@tanstack/react-table';
import type { ApiClientDto } from '@app/shared';

import { DateTime, RelativeTime } from '@/components/app/date-time';
import { ToneBadge } from '@/components/app/status-badge';

import { API_CLIENT_STATUS_META } from '../labels';
import { RevokeApiClientButton } from './revoke-api-client-dialog';

export function ApiClientStatusBadge({ status }: { status: ApiClientDto['status'] }) {
  const meta = API_CLIENT_STATUS_META[status] as
    | (typeof API_CLIENT_STATUS_META)[ApiClientDto['status']]
    | undefined;
  if (!meta) return <ToneBadge>{status}</ToneBadge>;
  return (
    <ToneBadge tone={meta.tone} title={meta.description}>
      {meta.label}
    </ToneBadge>
  );
}

export function KeyPrefix({ value }: { value: string }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs" title="Key prefix (not the key)">
      {value}…
    </code>
  );
}

function LastUsed({ value }: { value: string | null }) {
  return value ? <RelativeTime value={value} /> : <span className="text-muted-foreground">Never</span>;
}

export const apiClientColumns: ColumnDef<ApiClientDto>[] = [
  {
    id: 'name',
    header: 'Name',
    cell: ({ row }) => (
      <span className="block max-w-56 truncate font-medium" title={row.original.name}>
        {row.original.name}
      </span>
    ),
  },
  {
    id: 'program',
    header: 'Program',
    cell: ({ row }) => (
      <span className="flex min-w-0 flex-col">
        <span className="max-w-44 truncate" title={row.original.program.name}>
          {row.original.program.name}
        </span>
        <span className="font-mono text-xs text-muted-foreground">{row.original.program.code}</span>
      </span>
    ),
  },
  {
    id: 'keyPrefix',
    header: 'Key',
    cell: ({ row }) => <KeyPrefix value={row.original.keyPrefix} />,
  },
  {
    id: 'status',
    header: 'Status',
    cell: ({ row }) => <ApiClientStatusBadge status={row.original.status} />,
  },
  {
    id: 'created',
    header: 'Created',
    cell: ({ row }) => (
      <span className="flex flex-col">
        <DateTime value={row.original.createdAt} style="date" />
        <span className="max-w-40 truncate text-xs text-muted-foreground">
          {row.original.createdBy ? `by ${row.original.createdBy.fullName}` : 'by system'}
        </span>
      </span>
    ),
  },
  {
    id: 'lastUsed',
    header: 'Last used',
    cell: ({ row }) => <LastUsed value={row.original.lastUsedAt} />,
  },
  {
    id: 'revokedAt',
    header: 'Revoked',
    cell: ({ row }) => <DateTime value={row.original.revokedAt} style="date" />,
  },
  {
    id: 'actions',
    header: () => <span className="sr-only">Actions</span>,
    meta: { align: 'right' },
    cell: ({ row }) =>
      row.original.status === 'ACTIVE' ? <RevokeApiClientButton client={row.original} /> : null,
  },
];

/** Mobile card (below `md`). */
export function ApiClientCard({ client }: { client: ApiClientDto }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="block truncate font-medium">{client.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {client.program.name} · <span className="font-mono">{client.program.code}</span>
          </span>
        </span>
        <ApiClientStatusBadge status={client.status} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <KeyPrefix value={client.keyPrefix} />
        <span>
          Created <DateTime value={client.createdAt} style="date" />
        </span>
        <span>
          Last used <LastUsed value={client.lastUsedAt} />
        </span>
        {client.revokedAt ? (
          <span>
            Revoked <DateTime value={client.revokedAt} style="date" />
          </span>
        ) : null}
      </div>
      {client.status === 'ACTIVE' ? (
        <div>
          <RevokeApiClientButton client={client} />
        </div>
      ) : null}
    </div>
  );
}
