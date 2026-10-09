import { Settings } from 'lucide-react';
import type { Metadata } from 'next';
import { Permission } from '@app/shared';

import { ComingSoon } from '@/components/app/coming-soon';
import { RequirePermission } from '@/components/app/guards';

// Route stub — a feature slice replaces this page (keep the RequirePermission guard).
export const metadata: Metadata = { title: 'Settings' };

export default function Page() {
  return (
    <RequirePermission perm={Permission.SettingsWrite}>
      <ComingSoon
        title="Settings"
        description="Reward unit, currency and other platform-wide settings."
        icon={Settings}
      />
    </RequirePermission>
  );
}
