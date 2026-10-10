import type { Metadata } from 'next';
import { Permission } from '@app/shared';

import { RequirePermission } from '@/components/app/guards';
import { LedgerPage } from '@/features/ledger/components/ledger-page';

export const metadata: Metadata = { title: 'Ledger' };

export default function Page() {
  return (
    <RequirePermission perm={Permission.LedgerRead}>
      <LedgerPage />
    </RequirePermission>
  );
}
