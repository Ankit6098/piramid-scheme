import type { Metadata } from 'next';

import { RegisterForm } from '@/features/auth/components/register-form';

export const metadata: Metadata = { title: 'Create your account' };

export default function Page() {
  return <RegisterForm />;
}
