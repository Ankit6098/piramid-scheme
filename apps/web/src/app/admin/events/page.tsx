import { ReceiptText } from 'lucide-react';
import type { Metadata } from 'next';
import { Permission } from '@app/shared';

import { ComingSoon } from '@/components/app/coming-soon';
import { RequirePermission } from '@/components/app/guards';

// Route stub — a feature slice replaces this page (keep the RequirePermission guard).
export const metadata: Metadata = { title: 'Events' };

export default function Page() {
  return (
    <RequirePermission anyOf={[Permission.EventsWrite, Permission.EventsReverse]}>
      <ComingSoon
        title="Events"
        description="Qualifying sale events and their processing results."
        icon={ReceiptText}
      />
    </RequirePermission>
  );
}
