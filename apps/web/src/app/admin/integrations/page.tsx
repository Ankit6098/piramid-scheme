import type { Metadata } from 'next';
import { Permission } from '@app/shared';

import { RequirePermission } from '@/components/app/guards';
import { IntegrationsPage } from '@/features/integrations/components/integrations-page';

export const metadata: Metadata = { title: 'Integrations' };

export default function Page() {
  return (
    <RequirePermission perm={Permission.IntegrationsManage}>
      <IntegrationsPage />
    </RequirePermission>
  );
}
