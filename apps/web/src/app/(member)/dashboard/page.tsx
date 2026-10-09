import { LayoutDashboard } from 'lucide-react';
import type { Metadata } from 'next';

import { ComingSoon } from '@/components/app/coming-soon';

// Route stub — a feature slice replaces this page.
export const metadata: Metadata = { title: 'Dashboard' };

export default function Page() {
  return (
    <ComingSoon
      title="Dashboard"
      description="Your programs, referral link and recorded rewards at a glance."
      icon={LayoutDashboard}
    />
  );
}
