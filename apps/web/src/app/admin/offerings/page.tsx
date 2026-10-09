import { ShoppingBag } from 'lucide-react';
import type { Metadata } from 'next';
import { Permission } from '@app/shared';

import { ComingSoon } from '@/components/app/coming-soon';
import { RequirePermission } from '@/components/app/guards';

// Route stub — a feature slice replaces this page (keep the RequirePermission guard).
export const metadata: Metadata = { title: 'Offerings' };

export default function Page() {
  return (
    <RequirePermission perm={Permission.OfferingsWrite}>
      <ComingSoon
        title="Offerings"
        description="Approved products and services that programs can reference."
        icon={ShoppingBag}
      />
    </RequirePermission>
  );
}
