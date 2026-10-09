import { Boxes } from 'lucide-react';
import type { Metadata } from 'next';
import { Permission } from '@app/shared';

import { ComingSoon } from '@/components/app/coming-soon';
import { RequirePermission } from '@/components/app/guards';

// Route stub — a feature slice replaces this page (keep the RequirePermission guard).
export const metadata: Metadata = { title: 'Programs' };

export default function Page() {
  return (
    <RequirePermission perm={Permission.ProgramsRead}>
      <ComingSoon
        title="Programs"
        description="Programs, their options and effective-dated reward policies."
        icon={Boxes}
      />
    </RequirePermission>
  );
}
