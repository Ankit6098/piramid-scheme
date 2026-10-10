import type { Metadata } from 'next';
import { Permission } from '@app/shared';

import { RequirePermission } from '@/components/app/guards';
import { PoliciesPage } from '@/features/policies/components/policies-page';

export const metadata: Metadata = { title: 'Reward policies' };

export default function Page() {
  return (
    <RequirePermission perm={Permission.ProgramsRead}>
      <PoliciesPage />
    </RequirePermission>
  );
}
