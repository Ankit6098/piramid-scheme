import type { Metadata } from 'next';

import { AuthComingSoon } from '@/components/app/coming-soon';

// Route stub — the auth slice replaces this page.
export const metadata: Metadata = { title: 'Verify your email' };

export default function Page() {
  return (
    <AuthComingSoon
      title="Verify your email"
      description="Enter the 6-digit code we emailed you."
    />
  );
}
