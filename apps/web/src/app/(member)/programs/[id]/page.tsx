import type { Metadata } from 'next';

import { MemberProgramDetail } from '@/features/programs/components/member/member-program-detail';

export const metadata: Metadata = { title: 'Program' };

export default function Page() {
  return <MemberProgramDetail />;
}
