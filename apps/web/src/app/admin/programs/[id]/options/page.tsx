import type { Metadata } from 'next';

import { ProgramOptionsTab } from '@/features/programs/components/admin/program-options-tab';

export const metadata: Metadata = { title: 'Program options' };

export default function Page() {
  return <ProgramOptionsTab />;
}
