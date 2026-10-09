import { Users } from 'lucide-react';
import type { Metadata } from 'next';
import { Permission } from '@app/shared';

import { ComingSoon } from '@/components/app/coming-soon';
import { RequirePermission } from '@/components/app/guards';

// Route stub — a feature slice replaces this page (keep the RequirePermission guard).
export const metadata: Metadata = { title: 'Members' };

export default function Page() {
  return (
    <RequirePermission perm={Permission.MembersRead}>
      <ComingSoon
        title="Members"
        description="Member accounts, statuses and referral relationships."
        icon={Users}
      />
    </RequirePermission>
  );
}
