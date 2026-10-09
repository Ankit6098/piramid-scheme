'use client';

/**
 * STUB — owned by the notifications slice, which replaces the internals (unread count from
 * `queryKeys.notifications.unreadCount()`, popover with the latest items, mark-as-read).
 * Keep the export name and props stable: the app shell top bar renders it.
 */
import { Bell } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { routes } from '@/config/routes';

export interface NotificationBellProps {
  /** Extra classes for the trigger button. */
  className?: string;
}

/** Top-bar notifications entry point (icon button). */
export function NotificationBell({ className }: NotificationBellProps) {
  return (
    <Button asChild variant="ghost" size="icon-sm" className={className}>
      <Link href={routes.member.notifications} aria-label="Notifications">
        <Bell aria-hidden />
      </Link>
    </Button>
  );
}
