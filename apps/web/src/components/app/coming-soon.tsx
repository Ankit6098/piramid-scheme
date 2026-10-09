import type { LucideIcon } from 'lucide-react';
import { Construction } from 'lucide-react';

import { AuthHeading } from '@/components/app/auth-heading';
import { PageHeader } from '@/components/app/page-header';
import { EmptyState } from '@/components/app/states';

/** Placeholder for (auth) route stubs (rendered inside the auth card). */
export function AuthComingSoon({ title, description }: { title: string; description?: string }) {
  return (
    <>
      <AuthHeading title={title} description={description} />
      <EmptyState
        variant="plain"
        size="sm"
        icon={Construction}
        title="Coming soon"
        description="This screen is being built."
      />
    </>
  );
}

/** Placeholder page body used by route stubs until a feature slice implements the page. */
export function ComingSoon({
  title,
  description,
  icon = Construction,
}: {
  title: string;
  description?: string;
  icon?: LucideIcon;
}) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <EmptyState
        icon={icon}
        title="Coming soon"
        description="This page is being built. Check back shortly."
      />
    </>
  );
}
