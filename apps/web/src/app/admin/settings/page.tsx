import type { Metadata } from 'next';
import { Permission } from '@app/shared';

import { RequirePermission } from '@/components/app/guards';
import { SettingsPage } from '@/features/settings/components/settings-page';

export const metadata: Metadata = { title: 'Settings' };

export default function Page() {
  return (
    <RequirePermission perm={Permission.SettingsWrite}>
      <SettingsPage />
    </RequirePermission>
  );
}
