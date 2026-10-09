import { Layers } from 'lucide-react';
import type { Metadata } from 'next';

import { ComingSoon } from '@/components/app/coming-soon';

// Route stub — a feature slice replaces this page.
export const metadata: Metadata = { title: 'Programs' };

export default function Page() {
  return (
    <ComingSoon
      title="Programs"
      description="Browse active programs for approved products and services, and manage your enrollments."
      icon={Layers}
    />
  );
}
