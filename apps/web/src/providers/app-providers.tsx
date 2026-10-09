'use client';

import type { ReactNode } from 'react';

import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PlatformSettingsProvider } from '@/providers/platform-settings-provider';
import { QueryProvider } from '@/providers/query-provider';
import { ThemeProvider } from '@/providers/theme-provider';

/** Root client providers (mounted once in `src/app/layout.tsx`). */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <QueryProvider>
        <PlatformSettingsProvider>
          <TooltipProvider delayDuration={300}>
            {children}
            <Toaster position="bottom-right" closeButton />
          </TooltipProvider>
        </PlatformSettingsProvider>
      </QueryProvider>
    </ThemeProvider>
  );
}
