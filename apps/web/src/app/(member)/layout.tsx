import type { ReactNode } from 'react';

import { AppShell } from '@/components/app/shell/app-shell';

/** Member area shell. The proxy requires a session cookie; <RequireAuth> (in AppShell) checks the session. */
export default function MemberLayout({ children }: { children: ReactNode }) {
  return <AppShell area="member">{children}</AppShell>;
}
