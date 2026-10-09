import { Flag } from 'lucide-react';
import type { Metadata } from 'next';
import { Permission } from '@app/shared';

import { ComingSoon } from '@/components/app/coming-soon';
import { RequirePermission } from '@/components/app/guards';

// Route stub — a feature slice replaces this page (keep the RequirePermission guard).
export const metadata: Metadata = { title: 'Flags' };

export default function Page() {
  return (
    <RequirePermission perm={Permission.FlagsManage}>
      <ComingSoon
        title="Flags"
        description="Suspicious-activity signals to review and resolve."
        icon={Flag}
      />
    </RequirePermission>
  );
}
