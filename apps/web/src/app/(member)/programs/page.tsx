import type { Metadata } from 'next';

import { MemberProgramsPage } from '@/features/programs/components/member/member-programs-page';

export const metadata: Metadata = { title: 'Programs' };

export default function Page() {
  return <MemberProgramsPage />;
}
