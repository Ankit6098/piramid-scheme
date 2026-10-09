import { Network } from 'lucide-react';
import type { Metadata } from 'next';

import { ComingSoon } from '@/components/app/coming-soon';

// Route stub — a feature slice replaces this page.
export const metadata: Metadata = { title: 'Team' };

export default function Page() {
  return (
    <ComingSoon
      title="Team"
      description="Members who joined through your network (names and join dates only)."
      icon={Network}
    />
  );
}
