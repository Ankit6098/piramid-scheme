import { Suspense, type ReactNode } from 'react';

import { RequireAuth } from '@/components/app/guards';
import { PageSkeleton } from '@/components/app/states';
import { SidebarProvider } from '@/components/ui/sidebar';
import type { AppArea } from '@/config/navigation';

import { AppSidebar } from './app-sidebar';
import { AppTopbar } from './app-topbar';

/**
 * Authenticated application shell (member area and admin console).
 * Static parts (sidebar frame, top bar, nav labels) are prerendered; everything that depends on the
 * session or URL renders inside Suspense boundaries, and page content is guarded by <RequireAuth>.
 */
export function AppShell({ area, children }: { area: AppArea; children: ReactNode }) {
  return (
    <SidebarProvider>
      <AppSidebar area={area} />
      <div
        data-slot="sidebar-inset"
        className="relative flex min-h-svh w-full min-w-0 flex-1 flex-col bg-background"
      >
        <AppTopbar area={area} />
        <main id="main-content" tabIndex={-1} className="flex-1 outline-none">
          <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            <Suspense fallback={<PageSkeleton />}>
              <RequireAuth area={area}>{children}</RequireAuth>
            </Suspense>
          </div>
        </main>
      </div>
    </SidebarProvider>
  );
}
