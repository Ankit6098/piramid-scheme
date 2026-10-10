import type { Metadata } from 'next';

import { SponsorPage } from '@/features/referrals/components/sponsor-page';

export const metadata: Metadata = { title: 'Sponsor' };

export default function Page() {
  return <SponsorPage />;
}
