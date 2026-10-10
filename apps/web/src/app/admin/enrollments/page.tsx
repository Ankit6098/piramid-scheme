import type { Metadata } from 'next';
import { Permission } from '@app/shared';

import { RequirePermission } from '@/components/app/guards';
import { AdminEnrollmentsPage } from '@/features/enrollments/components/admin-enrollments-page';

export const metadata: Metadata = { title: 'Enrollments' };

export default function Page() {
  return (
    <RequirePermission perm={Permission.EnrollmentsManage}>
      <AdminEnrollmentsPage />
    </RequirePermission>
  );
}
