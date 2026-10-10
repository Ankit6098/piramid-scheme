import type { Metadata } from 'next';
import { Permission } from '@app/shared';

import { RequirePermission } from '@/components/app/guards';
import { AuditPage } from '@/features/audit/components/audit-page';

export const metadata: Metadata = { title: 'Audit log' };

export default function Page() {
  return (
    <RequirePermission perm={Permission.AuditRead}>
      <AuditPage />
    </RequirePermission>
  );
}
