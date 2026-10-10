import type { Metadata } from 'next';
import { Permission } from '@app/shared';

import { RequirePermission } from '@/components/app/guards';
import { AdminMemberTeamPage } from '@/features/hierarchy/components/admin-member-team-page';

export const metadata: Metadata = { title: 'Member team' };

export default function Page() {
  return (
    <RequirePermission perm={Permission.MembersRead}>
      <AdminMemberTeamPage />
    </RequirePermission>
  );
}
