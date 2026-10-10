'use client';

import type { ColumnDef } from '@tanstack/react-table';
import { useQueryClient } from '@tanstack/react-query';
import { LogOut, MonitorSmartphone } from 'lucide-react';
import { useMemo } from 'react';
import { toast } from 'sonner';
import type { UserSessionDto } from '@app/shared';

import { ConfirmDialog } from '@/components/app/confirm-dialog';
import { DataTable } from '@/components/app/data-table';
import { DateTime, RelativeTime } from '@/components/app/date-time';
import { EmptyState } from '@/components/app/states';
import { ToneBadge } from '@/components/app/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { routes } from '@/config/routes';
import { hardNavigate } from '@/features/auth/lib/navigation';
import { getErrorMessage } from '@/lib/api-client';

import { useRevokeOtherSessions, useRevokeSession, useSessionsList } from '../api';
import { describeUserAgent } from '../lib/format';

function RevokeButton({ session }: { session: UserSessionDto }) {
  const revoke = useRevokeSession();
  const queryClient = useQueryClient();
  return (
    <ConfirmDialog
      trigger={
        <Button
          variant="ghost"
          size="sm"
          aria-label={
            session.current
              ? 'Sign out of this device'
              : `Sign out ${describeUserAgent(session.userAgent)}`
          }
        >
          <LogOut aria-hidden />
          Sign out
        </Button>
      }
      title={session.current ? 'Sign out of this device?' : 'Sign out this session?'}
      description={
        session.current
          ? 'You will need to sign in again on this device.'
          : `${describeUserAgent(session.userAgent)} will be signed out immediately.`
      }
      confirmLabel="Sign out"
      variant="destructive"
      onConfirm={async () => {
        try {
          const res = await revoke.mutateAsync(session.id);
          if (res.current) hardNavigate(queryClient, routes.auth.login);
          else toast.success('Session signed out');
        } catch (error) {
          throw new Error(getErrorMessage(error));
        }
      }}
    />
  );
}

function SessionDevice({ session }: { session: UserSessionDto }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <MonitorSmartphone className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate font-medium">{describeUserAgent(session.userAgent)}</span>
      {session.current ? <ToneBadge tone="primary">This device</ToneBadge> : null}
    </div>
  );
}

/** Open sessions of the account with per-session and "all other devices" sign-out. */
export function SessionsCard() {
  const list = useSessionsList();
  const revokeOthers = useRevokeOtherSessions();
  const otherCount = list.rows.filter((s) => !s.current).length;

  const columns = useMemo<ColumnDef<UserSessionDto>[]>(
    () => [
      {
        id: 'device',
        header: 'Device',
        cell: ({ row }) => <SessionDevice session={row.original} />,
      },
      {
        id: 'ip',
        header: 'IP address',
        cell: ({ row }) => (
          <span className="font-mono text-xs">{row.original.ipAddress ?? '—'}</span>
        ),
      },
      {
        id: 'lastSeen',
        header: 'Last active',
        cell: ({ row }) => <RelativeTime value={row.original.lastSeenAt} />,
      },
      {
        id: 'createdAt',
        header: 'Signed in',
        cell: ({ row }) => <DateTime value={row.original.createdAt} style="datetime" />,
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        meta: { align: 'right' },
        cell: ({ row }) => <RevokeButton session={row.original} />,
      },
    ],
    [],
  );

  return (
    <Card>
      <CardHeader className="gap-3 sm:flex sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            <MonitorSmartphone className="size-4 text-muted-foreground" aria-hidden />
            Where you&apos;re signed in
          </CardTitle>
          <CardDescription>
            Sign out any session you don&apos;t recognise, then change your password.
          </CardDescription>
        </div>
        <ConfirmDialog
          trigger={
            <Button variant="outline" size="sm" disabled={otherCount === 0}>
              Sign out other devices
            </Button>
          }
          title="Sign out all other devices?"
          description="Every session except this one is signed out immediately."
          confirmLabel="Sign out others"
          variant="destructive"
          onConfirm={async () => {
            try {
              const res = await revokeOthers.mutateAsync();
              toast.success(
                res.revoked === 1 ? '1 session signed out' : `${res.revoked} sessions signed out`,
              );
            } catch (error) {
              throw new Error(getErrorMessage(error));
            }
          }}
        />
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
          caption="Your signed-in sessions"
          emptyState={
            <EmptyState
              variant="plain"
              size="sm"
              icon={MonitorSmartphone}
              title="No other sessions"
            />
          }
          renderCard={(session) => (
            <div className="space-y-2 rounded-lg border p-3 text-sm">
              <div className="flex items-start justify-between gap-2">
                <SessionDevice session={session} />
                <RevokeButton session={session} />
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <dt>Last active</dt>
                <dd className="text-foreground">
                  <RelativeTime value={session.lastSeenAt} />
                </dd>
                <dt>IP address</dt>
                <dd className="font-mono text-foreground">{session.ipAddress ?? '—'}</dd>
              </dl>
            </div>
          )}
        />
      </CardContent>
    </Card>
  );
}
