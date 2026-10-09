import { Scale } from 'lucide-react';
import type { Metadata } from 'next';
import { Permission } from '@app/shared';

import { ComingSoon } from '@/components/app/coming-soon';
import { RequirePermission } from '@/components/app/guards';

// Route stub — a feature slice replaces this page (keep the RequirePermission guard).
export const metadata: Metadata = { title: 'Reconciliation' };

export default function Page() {
  return (
    <RequirePermission perm={Permission.ReconciliationRead}>
      <ComingSoon
        title="Reconciliation"
        description="Consistency checks between rewards and ledger postings."
        icon={Scale}
      />
    </RequirePermission>
  );
}
