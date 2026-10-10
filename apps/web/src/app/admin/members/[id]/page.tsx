import type { Metadata } from 'next';

import { MemberOverview } from '@/features/members/components/member-overview';

export const metadata: Metadata = { title: 'Member' };

export default function Page() {
  return <MemberOverview />;
}
