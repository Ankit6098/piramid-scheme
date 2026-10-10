import type { Metadata } from 'next';

import { ProgramEnrollmentsTab } from '@/features/programs/components/admin/program-enrollments-tab';

export const metadata: Metadata = { title: 'Program enrollments' };

export default function Page() {
  return <ProgramEnrollmentsTab />;
}
