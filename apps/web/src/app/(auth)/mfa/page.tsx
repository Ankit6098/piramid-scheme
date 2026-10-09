import type { Metadata } from 'next';

import { AuthComingSoon } from '@/components/app/coming-soon';

// Route stub — the auth slice replaces this page.
export const metadata: Metadata = { title: "Confirm it's you" };

export default function Page() {
  return (
    <AuthComingSoon
      title="Confirm it's you"
      description="Admin sessions need a one-time code sent to your email."
    />
  );
}
