import type { Metadata } from 'next';
import { Permission } from '@app/shared';

import { RequirePermission } from '@/components/app/guards';
import { ProgramsListPage } from '@/features/programs/components/admin/programs-list-page';

export const metadata: Metadata = { title: 'Programs' };

export default function Page() {
  return (
    <RequirePermission perm={Permission.ProgramsRead}>
      <ProgramsListPage />
    </RequirePermission>
  );
}
