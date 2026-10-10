import type { Metadata } from 'next';

import { AdminOverviewPage } from '@/features/admin/components/admin-overview-page';

// Any admin may open the overview; the API scopes the figures to the caller.
export const metadata: Metadata = { title: 'Admin overview' };

export default function Page() {
  return <AdminOverviewPage />;
}
