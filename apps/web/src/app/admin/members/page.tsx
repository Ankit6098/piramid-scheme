import type { Metadata } from 'next';
import { Permission } from '@app/shared';

import { RequirePermission } from '@/components/app/guards';
import { MembersPage } from '@/features/members/components/members-page';

export const metadata: Metadata = { title: 'Members' };

export default function Page() {
  return (
    <RequirePermission perm={Permission.MembersRead}>
      <MembersPage />
    </RequirePermission>
  );
}
