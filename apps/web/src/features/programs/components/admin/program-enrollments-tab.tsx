'use client';

import { useParams } from 'next/navigation';
import { Permission } from '@app/shared';

import { RequirePermission } from '@/components/app/guards';
import { SectionHeader } from '@/components/app/page-header';
import { AdminEnrollmentsTable } from '@/features/enrollments/components/admin-enrollments-table';

/** /admin/programs/[id]/enrollments — this program's enrollments (activate, reject, cancel). */
export function ProgramEnrollmentsTab() {
  const { id } = useParams<{ id: string }>();
  return (
    <RequirePermission perm={Permission.EnrollmentsManage}>
      <div className="space-y-4">
        <SectionHeader
          title="Enrollments"
          description="Activate paid plans after recording the member’s offline payment, or reject them with a reason."
        />
        <AdminEnrollmentsTable programId={id} defaultStatus="ALL" />
      </div>
    </RequirePermission>
  );
}
