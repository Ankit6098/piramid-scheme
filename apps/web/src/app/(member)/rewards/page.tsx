import type { Metadata } from 'next';

import { MemberRewardsPage } from '@/features/rewards/components/member/member-rewards-page';

export const metadata: Metadata = { title: 'Rewards' };

export default function Page() {
  return <MemberRewardsPage />;
}
