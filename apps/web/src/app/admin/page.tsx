import { Gauge } from 'lucide-react';
import type { Metadata } from 'next';

import { ComingSoon } from '@/components/app/coming-soon';

// Route stub — the admin overview slice replaces this page. (Any admin may open it.)
export const metadata: Metadata = { title: 'Admin overview' };

export default function Page() {
  return (
    <ComingSoon
      title="Overview"
      description="Platform health, pending reviews and reconciliation exceptions."
      icon={Gauge}
    />
  );
}
