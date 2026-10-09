import { ScrollText } from 'lucide-react';
import type { Metadata } from 'next';
import { Permission } from '@app/shared';

import { ComingSoon } from '@/components/app/coming-soon';
import { RequirePermission } from '@/components/app/guards';

// Route stub — a feature slice replaces this page (keep the RequirePermission guard).
export const metadata: Metadata = { title: 'Audit log' };

export default function Page() {
  return (
    <RequirePermission perm={Permission.AuditRead}>
      <ComingSoon
        title="Audit log"
        description="Every administrative change, with actor and reason."
        icon={ScrollText}
      />
    </RequirePermission>
  );
}
