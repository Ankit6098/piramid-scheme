import { Share2 } from 'lucide-react';
import type { Metadata } from 'next';

import { ComingSoon } from '@/components/app/coming-soon';

// Route stub — a feature slice replaces this page.
export const metadata: Metadata = { title: 'Referrals' };

export default function Page() {
  return (
    <ComingSoon
      title="Referrals"
      description="Your referral link and code. Sign-ups are attributed to you; rewards come only from qualifying sales."
      icon={Share2}
    />
  );
}
