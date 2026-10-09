import { UserRound } from 'lucide-react';
import type { Metadata } from 'next';

import { ComingSoon } from '@/components/app/coming-soon';

// Route stub — a feature slice replaces this page.
export const metadata: Metadata = { title: 'Profile' };

export default function Page() {
  return (
    <ComingSoon
      title="Profile"
      description="Your personal details, email address and password."
      icon={UserRound}
    />
  );
}
