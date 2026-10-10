import type { Metadata } from 'next';
import { Permission } from '@app/shared';

import { RequirePermission } from '@/components/app/guards';
import { OfferingsPage } from '@/features/offerings/components/offerings-page';

export const metadata: Metadata = { title: 'Offerings' };

export default function Page() {
  return (
    <RequirePermission perm={Permission.OfferingsWrite}>
      <OfferingsPage />
    </RequirePermission>
  );
}
