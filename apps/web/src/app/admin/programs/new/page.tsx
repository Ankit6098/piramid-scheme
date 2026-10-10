import type { Metadata } from 'next';
import { Permission } from '@app/shared';

import { RequirePermission } from '@/components/app/guards';
import { NewProgramPage } from '@/features/programs/components/admin/new-program-page';

export const metadata: Metadata = { title: 'New program' };

export default function Page() {
  return (
    <RequirePermission perm={Permission.ProgramsWrite}>
      <NewProgramPage />
    </RequirePermission>
  );
}
