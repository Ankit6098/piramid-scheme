import type { Metadata } from 'next';

import { ProgramHistoryTab } from '@/features/programs/components/admin/program-history-tab';

export const metadata: Metadata = { title: 'Program history' };

export default function Page() {
  return <ProgramHistoryTab />;
}
