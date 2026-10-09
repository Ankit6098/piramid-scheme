import type { Metadata } from 'next';

import { AuthComingSoon } from '@/components/app/coming-soon';

// Route stub — the auth slice replaces this page.
export const metadata: Metadata = { title: 'Choose a new password' };

export default function Page() {
  return (
    <AuthComingSoon
      title="Choose a new password"
      description="Enter the code from your email and a new password."
    />
  );
}
