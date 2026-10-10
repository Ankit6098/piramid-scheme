import type { ReactNode } from 'react';
import { Permission } from '@app/shared';

import { RequirePermission } from '@/components/app/guards';
import { ProgramDetailShell } from '@/features/programs/components/admin/program-detail-shell';

/** Program header + route tabs for /admin/programs/[id]/** (the shell reads the id with useParams). */
export default function ProgramLayout({ children }: { children: ReactNode }) {
  return (
    <RequirePermission perm={Permission.ProgramsRead}>
      <ProgramDetailShell>{children}</ProgramDetailShell>
    </RequirePermission>
  );
}
