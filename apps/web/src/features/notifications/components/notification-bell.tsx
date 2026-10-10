'use client';

/**
 * Top-bar notifications entry point (rendered by the app shell for members and admins): unread badge
 * (polled every minute while the tab is visible), popover with the latest notifications, mark one or
 * all as read, link to the full list. Keep the export name and props stable.
 */
import { Bell, CheckCheck, Inbox } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { routes } from '@/config/routes';
import { useSession } from '@/hooks/use-session';
import { getErrorMessage } from '@/lib/api-client';
import { cn } from '@/lib/utils';

import {
  useLatestNotifications,
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useUnreadNotificationCount,
} from '../api';
import { NotificationItem } from './notification-item';

export interface NotificationBellProps {
  /** Extra classes for the trigger button. */
  className?: string;
}

function badgeText(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/** Top-bar notifications entry point (icon button + popover). */
export function NotificationBell({ className }: NotificationBellProps) {
  const { status } = useSession();
  const signedIn = status === 'authenticated';
  const [open, setOpen] = useState(false);
  const unread = useUnreadNotificationCount({ enabled: signedIn });
  const latest = useLatestNotifications({ enabled: signedIn && open });
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();

  const count = unread.data?.count ?? 0;
  const label = count > 0 ? `Notifications, ${count} unread` : 'Notifications';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn('relative', className)}
          aria-label={label}
          disabled={!signedIn}
        >
          <Bell aria-hidden />
          {count > 0 ? (
            <span
              aria-hidden
              className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[0.625rem] leading-none font-semibold text-primary-foreground tabular-nums ring-2 ring-background"
            >
              {badgeText(count)}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-1.5rem))] gap-0 p-0">
        <div className="flex items-center justify-between gap-2 px-3 py-2.5">
          <div>
            <h2 className="text-sm font-semibold">Notifications</h2>
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {count > 0 ? `${count} unread` : 'You are all caught up'}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => markAll.mutate()}
            disabled={count === 0 || markAll.isPending}
          >
            <CheckCheck aria-hidden />
            Mark all read
          </Button>
        </div>
        <Separator />
        <div className="max-h-96 overflow-y-auto overscroll-contain">
          {latest.isPending ? (
            <div className="space-y-3 p-3" aria-busy>
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="flex gap-3">
                  <Skeleton className="size-8 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="h-3 w-full" />
                  </div>
                </div>
              ))}
              <span className="sr-only">Loading notifications</span>
            </div>
          ) : latest.error ? (
            <p role="alert" className="p-4 text-sm text-destructive">
              {getErrorMessage(latest.error)}
            </p>
          ) : latest.data.data.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground">
              <Inbox className="size-5" aria-hidden />
              No notifications yet.
            </div>
          ) : (
            <ul className="divide-y">
              {latest.data.data.map((n) => (
                <li key={n.id}>
                  <NotificationItem
                    notification={n}
                    variant="compact"
                    onMarkRead={(id) => markRead.mutate(id)}
                    markReadPending={markRead.isPending}
                    onNavigate={() => setOpen(false)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
        <Separator />
        <div className="p-1.5">
          <Button asChild variant="ghost" size="sm" className="w-full">
            <Link href={routes.member.notifications} onClick={() => setOpen(false)}>
              View all notifications
            </Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
