import type { Metadata } from 'next';

import { ProgramAdminsTab } from '@/features/programs/components/admin/program-admins-tab';

export const metadata: Metadata = { title: 'Program admins' };

export default function Page() {
  return <ProgramAdminsTab />;
}
