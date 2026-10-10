'use client';

import type { ColumnDef } from '@tanstack/react-table';
import { History } from 'lucide-react';
import { useMemo } from 'react';
import type { ActivityEntryDto } from '@app/shared';

import { DataTable } from '@/components/app/data-table';
import { DateTime, RelativeTime } from '@/components/app/date-time';
import { EmptyState } from '@/components/app/states';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import { useActivityList } from '../api';
import { activityLabel } from '../lib/format';

/** The account's own audit trail (sign-ins, security changes, profile edits). */
export function ActivityCard() {
  const list = useActivityList();
  const columns = useMemo<ColumnDef<ActivityEntryDto>[]>(
    () => [
      {
        id: 'action',
        header: 'Activity',
        cell: ({ row }) => (
          <span className="font-medium">{activityLabel(row.original.action)}</span>
        ),
      },
      {
        id: 'when',
        header: 'When',
        cell: ({ row }) => <DateTime value={row.original.createdAt} style="datetime" />,
      },
      {
        id: 'ip',
        header: 'From IP',
        cell: ({ row }) => (
          <span className="font-mono text-xs">{row.original.ipAddress ?? '—'}</span>
        ),
      },
    ],
    [],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="size-4 text-muted-foreground" aria-hidden />
          Account activity
        </CardTitle>
        <CardDescription>
          Recent sign-ins and changes to your account. IP addresses are partly hidden.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable
          columns={columns}
          data={list.rows}
          getRowId={(row) => row.id}
          isLoading={list.isLoading}
          isFetching={list.isFetching}
          error={list.error}
          onRetry={list.refetch}
          pagination={list.pagination}
          caption="Your account activity"
          emptyState={
            <EmptyState
              variant="plain"
              size="sm"
              icon={History}
              title="No activity yet"
              description="Sign-ins and security changes will appear here."
            />
          }
          renderCard={(entry) => (
            <div className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
              <span className="font-medium">{activityLabel(entry.action)}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                <RelativeTime value={entry.createdAt} />
              </span>
            </div>
          )}
        />
      </CardContent>
    </Card>
  );
}
