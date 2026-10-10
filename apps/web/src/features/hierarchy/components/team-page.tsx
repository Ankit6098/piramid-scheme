'use client';

import { useQuery } from '@tanstack/react-query';
import { Share2 } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { routes } from '@/config/routes';

import { hierarchyKeys } from '../query-keys';
import { memberHierarchySource } from '../sources';
import { HierarchyExplorer } from './hierarchy-explorer';
import { DepthLegend, TeamStats } from './team-stats';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/team`: KPIs, depth legend and the interactive hierarchy of the member's own team. */
export function TeamPage() {
  const source = memberHierarchySource;
  const params = useSearchParams();
  const focus = params.get('focus');
  const summary = useQuery({
    queryKey: hierarchyKeys.summary(source.key),
    queryFn: ({ signal }) => source.summary(signal),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team"
        description="Members who joined through your network, up to 10 levels deep. You see first names, last initials, join dates and whether they are active or enrolled — nothing else."
        actions={
          <Button asChild variant="outline">
            <Link href={routes.member.referrals}>
              <Share2 aria-hidden />
              Referral link
            </Link>
          </Button>
        }
      />
      {summary.error ? (
        <ErrorState
          error={summary.error}
          onRetry={() => void summary.refetch()}
          variant="plain"
          title="Couldn't load team counts"
        />
      ) : (
        <>
          <TeamStats summary={summary.data} loading={summary.isPending} />
          <DepthLegend summary={summary.data} loading={summary.isPending} />
        </>
      )}
      <HierarchyExplorer source={source} initialFocusId={focus && UUID_RE.test(focus) ? focus : null} />
    </div>
  );
}
