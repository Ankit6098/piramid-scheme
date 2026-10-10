import type { ReactNode } from 'react';
import { Suspense } from 'react';
import { Permission } from '@app/shared';

import { RequirePermission } from '@/components/app/guards';
import { PageSkeleton } from '@/components/app/states';
import { MemberDetailShell } from '@/features/members/components/member-detail-shell';

/**
 * Member detail frame: header (name, status, roles, actions) + route tabs (Overview, Team). The Team
 * tab (`./team`) is built by the referrals feature; this layout wraps it.
 */
export default function MemberLayout({ children }: { children: ReactNode }) {
  return (
    <RequirePermission perm={Permission.MembersRead}>
      <Suspense fallback={<PageSkeleton />}>
        <MemberDetailShell>{children}</MemberDetailShell>
      </Suspense>
    </RequirePermission>
  );
}
