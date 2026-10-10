import type { Metadata } from 'next';

import { MfaFlow } from '@/features/auth/components/mfa-flow';

export const metadata: Metadata = { title: "Confirm it's you" };

export default function Page() {
  return <MfaFlow />;
}
