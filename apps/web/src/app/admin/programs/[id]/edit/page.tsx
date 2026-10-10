import type { Metadata } from 'next';
import { Permission } from '@app/shared';

import { RequirePermission } from '@/components/app/guards';
import { EditProgramPage } from '@/features/programs/components/admin/edit-program-page';

export const metadata: Metadata = { title: 'Edit program' };

export default function Page() {
  return (
    <RequirePermission perm={Permission.ProgramsWrite}>
      <EditProgramPage />
    </RequirePermission>
  );
}
