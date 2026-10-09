'use client';

import { Suspense } from 'react';

import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import type { AppArea } from '@/config/navigation';
import { NotificationBell } from '@/features/notifications/components/notification-bell';

import { AccountMenu } from './account-menu';
import { AppBreadcrumbs } from './app-breadcrumbs';
import { CommandMenu } from './command-menu';

/** Sticky top bar: sidebar toggle, breadcrumbs, search (⌘K), notifications, account menu. */
export function AppTopbar({ area }: { area: AppArea }) {
  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-3 sm:px-4">
      <SidebarTrigger className="-ml-1" aria-label="Toggle navigation" />
      <Separator
        orientation="vertical"
        className="mr-1 data-vertical:h-4 data-vertical:self-center"
      />
      <Suspense fallback={<Skeleton className="h-4 w-32" />}>
        <AppBreadcrumbs className="flex-1" />
      </Suspense>
      <div className="ml-auto flex items-center gap-1.5">
        <Suspense fallback={<Skeleton className="h-8 w-8 sm:w-56" />}>
          <CommandMenu />
        </Suspense>
        <NotificationBell />
        <Suspense fallback={<Skeleton className="size-8 rounded-full" />}>
          <AccountMenu area={area} />
        </Suspense>
      </div>
    </header>
  );
}
