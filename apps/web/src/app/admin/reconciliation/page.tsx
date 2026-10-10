import type { Metadata } from 'next';
import { Permission } from '@app/shared';

import { RequirePermission } from '@/components/app/guards';
import { ReconciliationPage } from '@/features/reconciliation/components/reconciliation-page';

export const metadata: Metadata = { title: 'Reconciliation' };

export default function Page() {
  return (
    <RequirePermission perm={Permission.ReconciliationRead}>
      <ReconciliationPage />
    </RequirePermission>
  );
}
