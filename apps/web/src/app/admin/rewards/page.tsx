import type { Metadata } from 'next';
import { Permission } from '@app/shared';

import { RequirePermission } from '@/components/app/guards';
import { AdminRewardsPage } from '@/features/rewards/components/admin/admin-rewards-page';

export const metadata: Metadata = { title: 'Rewards' };

export default function Page() {
  return (
    <RequirePermission perm={Permission.RewardsRead}>
      <AdminRewardsPage />
    </RequirePermission>
  );
}
