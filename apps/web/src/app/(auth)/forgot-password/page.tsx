import type { Metadata } from 'next';

import { AuthComingSoon } from '@/components/app/coming-soon';

// Route stub — the auth slice replaces this page.
export const metadata: Metadata = { title: 'Reset your password' };

export default function Page() {
  return (
    <AuthComingSoon title="Reset your password" description="We'll email you a code to reset it." />
  );
}
