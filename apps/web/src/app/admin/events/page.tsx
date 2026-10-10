import type { Metadata } from 'next';
import { Permission } from '@app/shared';

import { RequirePermission } from '@/components/app/guards';
import { SalesEventsPage } from '@/features/events/components/sales-events-page';

export const metadata: Metadata = { title: 'Sales events' };

export default function Page() {
  return (
    <RequirePermission anyOf={[Permission.EventsWrite, Permission.EventsReverse]}>
      <SalesEventsPage />
    </RequirePermission>
  );
}
