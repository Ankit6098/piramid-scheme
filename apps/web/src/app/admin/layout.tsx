import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { AppShell } from '@/components/app/shell/app-shell';
import { siteConfig } from '@/config/site';

export const metadata: Metadata = {
  title: { default: `Admin · ${siteConfig.name}`, template: `%s · Admin · ${siteConfig.name}` },
};

/**
 * Admin console shell. <RequireAuth area="admin"> requires an admin role and a completed second
 * factor; individual pages add <RequirePermission>. The API enforces all of it again.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AppShell area="admin">{children}</AppShell>;
}
