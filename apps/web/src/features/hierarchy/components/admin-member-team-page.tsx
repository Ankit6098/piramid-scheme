'use client';

import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo } from 'react';
import { Permission, type AdminAncestorsResponse } from '@app/shared';

import { DateTime } from '@/components/app/date-time';
import { ErrorState } from '@/components/app/error-state';
import { Can } from '@/components/app/guards';
import { PageHeader } from '@/components/app/page-header';
import { NotFoundState, PageSkeleton } from '@/components/app/states';
import { ToneBadge } from '@/components/app/status-badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { routes } from '@/config/routes';
import { api } from '@/lib/api-client';

import { hierarchyKeys } from '../query-keys';
import { adminHierarchySource } from '../sources';
import { HierarchyExplorer } from './hierarchy-explorer';
import { SponsorCorrectionDialog } from './sponsor-correction-dialog';
import { DepthLegend, TeamStats } from './team-stats';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/admin/members/[id]/team` (inside the members slice's detail layout): the member's upline, team
 * tree (full names when in scope) and the audited sponsor correction.
 */
export function AdminMemberTeamPage() {
  const params = useParams<{ id: string }>();
  const memberId = params.id;
  if (!memberId || !UUID_RE.test(memberId)) {
    return <NotFoundState backHref={routes.admin.members} backLabel="Back to members" />;
  }
  return <AdminMemberTeam key={memberId} memberId={memberId} />;
}

function AdminMemberTeam({ memberId }: { memberId: string }) {
  const source = useMemo(() => adminHierarchySource(memberId), [memberId]);
  // Same key as the explorer's initial tree: shares the request and gives the member's name.
  const tree = useQuery({
    queryKey: hierarchyKeys.tree(source.key, null, 2),
    queryFn: ({ signal }) => source.tree(undefined, 2, signal),
  });
  const summary = useQuery({
    queryKey: hierarchyKeys.summary(source.key),
    queryFn: ({ signal }) => source.summary(signal),
  });
  const ancestors = useQuery({
    queryKey: hierarchyKeys.ancestors(memberId),
    queryFn: ({ signal }) => api.get<AdminAncestorsResponse>(`/admin/members/${memberId}/ancestors`, { signal }),
  });

  const root = tree.data?.root;
  const name = root ? (root.fullName ?? root.displayName) : null;

  if (tree.isPending) return <PageSkeleton />;
  if (tree.error || !root) return <ErrorState error={tree.error} onRetry={() => void tree.refetch()} />;

  return (
    <div className="space-y-6">
      {/* Rendered inside the member detail layout (header + tabs); this tab has its own <h1>. */}
      <PageHeader
        title="Team"
        description={`Referral network of ${name ?? 'this member'}: who sponsored them and who joined through them.`}
        actions={
          <Can perm={Permission.ReferralsCorrect}>
            <SponsorCorrectionDialog memberId={memberId} memberName={name ?? 'member'} />
          </Can>
        }
      />

      <UplineCard query={ancestors} />

      {summary.error ? (
        <ErrorState error={summary.error} onRetry={() => void summary.refetch()} variant="plain" title="Couldn't load team counts" />
      ) : (
        <>
          <TeamStats summary={summary.data} loading={summary.isPending} />
          <DepthLegend summary={summary.data} loading={summary.isPending} />
        </>
      )}

      <HierarchyExplorer source={source} />
    </div>
  );
}

function UplineCard({
  query,
}: {
  query: { data: AdminAncestorsResponse | undefined; isPending: boolean; error: unknown; refetch: () => unknown };
}) {
  return (
    <Card size="sm">
      <CardContent className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-heading text-sm font-semibold">Upline</h2>
          {query.data?.attributionSource ? (
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              {query.data.attributionSource === 'ADMIN_CORRECTION' ? (
                <ToneBadge tone="info" dot={false}>
                  <ShieldCheck className="size-3" aria-hidden />
                  Corrected by an administrator
                </ToneBadge>
              ) : (
                <ToneBadge tone="neutral" dot={false}>
                  Registration
                </ToneBadge>
              )}
              {query.data.attributedAt ? (
                <>
                  since <DateTime value={query.data.attributedAt} style="date" />
                </>
              ) : null}
            </span>
          ) : null}
        </div>
        {query.isPending ? (
          <Skeleton className="h-6 w-2/3" />
        ) : query.error ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} variant="plain" />
        ) : query.data && query.data.ancestors.length > 0 ? (
          <nav aria-label="Upline of this member">
            <ol className="flex flex-wrap items-center gap-1.5 text-sm">
              {[...query.data.ancestors].reverse().map((a) => (
                <li key={a.id} className="flex items-center gap-1.5">
                  {a.inScope ? (
                    <Link
                      href={`${routes.admin.members}/${a.id}/team`}
                      className="rounded-full bg-muted px-2.5 py-1 hover:bg-accent"
                      title={`Level ${a.depth} above`}
                    >
                      {a.fullName ?? a.displayName}
                    </Link>
                  ) : (
                    <span className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground italic" title="Not in your programs">
                      {a.displayName}
                    </span>
                  )}
                  <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />
                </li>
              ))}
              <li aria-current="page" className="rounded-full bg-primary/10 px-2.5 py-1 font-medium text-primary">
                This member
              </li>
            </ol>
          </nav>
        ) : (
          <p className="text-sm text-muted-foreground">No sponsor — this member is at the top of their tree.</p>
        )}
      </CardContent>
    </Card>
  );
}
