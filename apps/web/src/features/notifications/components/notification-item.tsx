'use client';

import { Check } from 'lucide-react';
import Link from 'next/link';
import type { NotificationDto } from '@app/shared';

import { RelativeTime } from '@/components/app/date-time';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { notificationMeta } from '../notification-meta';

export interface NotificationItemProps {
  notification: NotificationDto;
  /** Marks this notification read (button hidden when already read). */
  onMarkRead?: (id: string) => void;
  markReadPending?: boolean;
  /** `compact` = popover row (body clamped to two lines). */
  variant?: 'compact' | 'full';
  /** Called after following the "View" link (e.g. to close the popover). */
  onNavigate?: () => void;
  className?: string;
}

/** One notification: category icon, title, body, time, unread marker and actions. */
export function NotificationItem({
  notification: n,
  onMarkRead,
  markReadPending,
  variant = 'full',
  onNavigate,
  className,
}: NotificationItemProps) {
  const meta = notificationMeta(n.type);
  const Icon = meta.icon;
  const unread = n.readAt === null;
  return (
    <article
      className={cn('flex gap-3', variant === 'compact' ? 'px-3 py-2.5' : 'p-4', className)}
      aria-label={`${unread ? 'Unread: ' : ''}${n.title}`}
    >
      <span
        className={cn(
          'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full',
          unread ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
        )}
      >
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-start justify-between gap-2">
          <h3 className={cn('text-sm leading-snug', unread ? 'font-semibold' : 'font-medium')}>
            {n.title}
          </h3>
          {unread ? (
            <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-hidden />
          ) : null}
        </div>
        <p
          className={cn(
            'text-sm text-muted-foreground',
            variant === 'compact' ? 'line-clamp-2' : 'whitespace-pre-line',
          )}
        >
          {n.body}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-xs text-muted-foreground">
          <span>{meta.category}</span>
          <span aria-hidden>·</span>
          <RelativeTime value={n.createdAt} />
          {meta.href ? (
            <Link
              href={meta.href}
              onClick={() => {
                if (unread) onMarkRead?.(n.id);
                onNavigate?.();
              }}
              className="font-medium text-primary hover:underline"
            >
              View
            </Link>
          ) : null}
          {unread && onMarkRead ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="-my-1 ml-auto text-muted-foreground"
              onClick={() => onMarkRead(n.id)}
              disabled={markReadPending}
            >
              <Check aria-hidden />
              Mark as read
            </Button>
          ) : null}
        </div>
      </div>
    </article>
  );
}
