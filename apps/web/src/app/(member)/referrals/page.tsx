import type { Metadata } from 'next';

import { ReferralsPage } from '@/features/referrals/components/referrals-page';

export const metadata: Metadata = { title: 'Referrals' };

export default function Page() {
  return <ReferralsPage />;
}
