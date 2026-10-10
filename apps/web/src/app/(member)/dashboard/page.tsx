import type { Metadata } from 'next';

import { MemberDashboardPage } from '@/features/dashboard/components/member-dashboard-page';

export const metadata: Metadata = { title: 'Dashboard' };

export default function Page() {
  return <MemberDashboardPage />;
}
