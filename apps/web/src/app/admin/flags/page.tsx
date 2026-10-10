import type { Metadata } from 'next';
import { Permission } from '@app/shared';

import { RequirePermission } from '@/components/app/guards';
import { FlagsPage } from '@/features/flags/components/flags-page';

export const metadata: Metadata = { title: 'Flags' };

export default function Page() {
  return (
    <RequirePermission perm={Permission.FlagsManage}>
      <FlagsPage />
    </RequirePermission>
  );
}
