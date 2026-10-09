import { ClipboardCheck } from 'lucide-react';
import type { Metadata } from 'next';
import { Permission } from '@app/shared';

import { ComingSoon } from '@/components/app/coming-soon';
import { RequirePermission } from '@/components/app/guards';

// Route stub — a feature slice replaces this page (keep the RequirePermission guard).
export const metadata: Metadata = { title: 'Enrollments' };

export default function Page() {
  return (
    <RequirePermission perm={Permission.EnrollmentsManage}>
      <ComingSoon
        title="Enrollments"
        description="Activate paid enrollments after offline payment, or reject them."
        icon={ClipboardCheck}
      />
    </RequirePermission>
  );
}
