import { Handshake } from 'lucide-react';
import type { Metadata } from 'next';

import { ComingSoon } from '@/components/app/coming-soon';

// Route stub — a feature slice replaces this page.
export const metadata: Metadata = { title: 'Sponsor' };

export default function Page() {
  return (
    <ComingSoon
      title="Sponsor"
      description="The member who referred you, and their upline."
      icon={Handshake}
    />
  );
}
