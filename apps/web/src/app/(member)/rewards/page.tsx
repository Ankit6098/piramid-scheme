import { Gift } from 'lucide-react';
import type { Metadata } from 'next';

import { ComingSoon } from '@/components/app/coming-soon';

// Route stub — a feature slice replaces this page.
export const metadata: Metadata = { title: 'Rewards' };

export default function Page() {
  return (
    <ComingSoon
      title="Rewards"
      description="Rewards credited from qualifying sales: earned, pending and reversed."
      icon={Gift}
    />
  );
}
