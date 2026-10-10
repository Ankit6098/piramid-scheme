import type { Metadata } from 'next';

import { ProgramOverview } from '@/features/programs/components/admin/program-overview';

export const metadata: Metadata = { title: 'Program' };

export default function Page() {
  return <ProgramOverview />;
}
