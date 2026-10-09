import { Gift } from 'lucide-react';
import type { Metadata } from 'next';
import { Permission } from '@app/shared';

import { ComingSoon } from '@/components/app/coming-soon';
import { RequirePermission } from '@/components/app/guards';

// Route stub — a feature slice replaces this page (keep the RequirePermission guard).
export const metadata: Metadata = { title: 'Rewards' };

export default function Page() {
  return (
    <RequirePermission perm={Permission.RewardsRead}>
      <ComingSoon
        title="Rewards"
        description="Review, approve, reject and reverse rewards."
        icon={Gift}
      />
    </RequirePermission>
  );
}
