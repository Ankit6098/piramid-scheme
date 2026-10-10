import type { Metadata } from 'next';

import { VerifyEmailForm } from '@/features/auth/components/verify-email-form';

export const metadata: Metadata = { title: 'Verify your email' };

export default function Page() {
  return <VerifyEmailForm />;
}
