import { Bell } from 'lucide-react';
import type { Metadata } from 'next';

import { ComingSoon } from '@/components/app/coming-soon';

// Route stub — a feature slice replaces this page.
export const metadata: Metadata = { title: 'Notifications' };

export default function Page() {
  return (
    <ComingSoon
      title="Notifications"
      description="Messages about your account, enrollments and rewards."
      icon={Bell}
    />
  );
}
