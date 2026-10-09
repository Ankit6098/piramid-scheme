import type { Metadata } from 'next';

import { AuthComingSoon } from '@/components/app/coming-soon';

// Route stub — the auth slice replaces this page.
export const metadata: Metadata = { title: 'Sign in' };

export default function Page() {
  return <AuthComingSoon title="Sign in" description="Welcome back. Sign in to your account." />;
}
