'use client';

import { BellOff, CheckCheck, Inbox } from 'lucide-react';
import { useState } from 'react';
import type { NotificationDto } from '@app/shared';

import { useCursorList } from '@/components/app/data-table';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { EmptyState } from '@/components/app/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { queryKeys } from '@/lib/query-keys';

import {
  NOTIFICATIONS_PATH,
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useUnreadNotificationCount,
} from '../api';
import { NotificationItem } from './notification-item';

type Filter = 'all' | 'unread';

/** Full notification inbox: filter all/unread, mark one or all read, load more. */
export function NotificationsPage() {
  const [filter, setFilter] = useState<Filter>('all');
  const query = filter === 'unread' ? { unread: 'true' } : {};
  const list = useCursorList<NotificationDto>({
    queryKey: queryKeys.notifications.list({ page: true, filter }),
    path: NOTIFICATIONS_PATH,
    query,
    pageSize: 20,
  });
  const unread = useUnreadNotificationCount();
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const unreadCount = unread.data?.count ?? 0;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Notifications"
        description="Messages about your account, enrollments and recorded rewards."
        actions={
          <Button
            variant="outline"
            onClick={() => markAll.mutate()}
            disabled={unreadCount === 0 || markAll.isPending}
          >
            {markAll.isPending ? <Spinner aria-hidden /> : <CheckCheck aria-hidden />}
            Mark all as read
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={filter}
          onValueChange={(value) => value && setFilter(value as Filter)}
          aria-label="Show"
        >
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="unread">
            Unread{unreadCount > 0 ? ` (${unreadCount > 99 ? '99+' : unreadCount})` : ''}
          </ToggleGroupItem>
        </ToggleGroup>
        {list.isFetching && !list.isLoading ? (
          <span className="text-xs text-muted-foreground" aria-live="polite">
            Updating…
          </span>
        ) : null}
      </div>

      {list.isLoading ? (
        <Card className="gap-0 divide-y py-0" aria-busy>
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex gap-3 p-4">
              <Skeleton className="size-8 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3 w-5/6" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
          ))}
          <span className="sr-only">Loading notifications</span>
        </Card>
      ) : list.error && list.rows.length === 0 ? (
        <ErrorState error={list.error} onRetry={list.refetch} />
      ) : list.rows.length === 0 ? (
        filter === 'unread' ? (
          <EmptyState
            icon={BellOff}
            title="No unread notifications"
            description="You're all caught up."
            action={
              <Button variant="outline" onClick={() => setFilter('all')}>
                Show all notifications
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={Inbox}
            title="No notifications yet"
            description="Updates about your enrollments and rewards will appear here."
          />
        )
      ) : (
        <>
          <Card className="gap-0 py-0">
            <ul className="divide-y">
              {list.rows.map((n) => (
                <li key={n.id} className={n.readAt === null ? 'bg-primary/[0.03]' : undefined}>
                  <NotificationItem
                    notification={n}
                    onMarkRead={(id) => markRead.mutate(id)}
                    markReadPending={markRead.isPending}
                  />
                </li>
              ))}
            </ul>
          </Card>
          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
              Showing {list.rows.length} {list.rows.length === 1 ? 'notification' : 'notifications'}
              {list.pagination.hasNextPage ? '' : ' · end of list'}
            </p>
            {list.pagination.hasNextPage ? (
              <Button
                variant="outline"
                size="sm"
                onClick={list.pagination.fetchNextPage}
                disabled={list.pagination.isFetchingNextPage}
              >
                {list.pagination.isFetchingNextPage ? <Spinner aria-hidden /> : null}
                Load more
              </Button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
