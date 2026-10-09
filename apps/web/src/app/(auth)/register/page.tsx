import type { Metadata } from 'next';

import { AuthComingSoon } from '@/components/app/coming-soon';

// Route stub — the auth slice replaces this page.
export const metadata: Metadata = { title: 'Create your account' };

export default function Page() {
  return (
    <AuthComingSoon
      title="Create your account"
      description="Join with an email address. A referral code is optional."
    />
  );
}
