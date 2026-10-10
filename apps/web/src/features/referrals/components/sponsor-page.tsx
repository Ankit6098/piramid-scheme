'use client';

import { ChevronRight, Handshake, ShieldCheck, UserRound } from 'lucide-react';
import Link from 'next/link';
import type { MyParentResponse } from '@app/shared';

import { DateTime } from '@/components/app/date-time';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader, SectionHeader } from '@/components/app/page-header';
import { CardSkeleton, EmptyState } from '@/components/app/states';
import { ToneBadge } from '@/components/app/status-badge';
import { UserAvatar } from '@/components/app/user-avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { routes } from '@/config/routes';

import { useMyParent } from '../api';

/** `/sponsor` ("My parent"): sponsor card, attribution date and the upline breadcrumb. */
export function SponsorPage() {
  const query = useMyParent();

  return (
    <div className="space-y-8">
      <PageHeader
        title="My sponsor"
        description="The member who referred you, and their upline. Only first names and last initials are shown."
      />
      {query.isPending ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <CardSkeleton lines={3} />
          <CardSkeleton lines={4} className="lg:col-span-2" />
        </div>
      ) : query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data ? (
        <SponsorDetails data={query.data} />
      ) : (
        <EmptyState
          icon={Handshake}
          title="You joined without a sponsor"
          description="Your account isn't linked to a referring member. That doesn't affect your access to programs."
          action={
            <Button asChild variant="outline">
              <Link href={routes.member.referrals}>Go to your referral link</Link>
            </Button>
          }
        />
      )}
    </div>
  );
}

function SponsorDetails({ data }: { data: MyParentResponse }) {
  const { sponsor, ancestors, hasMoreAncestors } = data;
  // Upline from the top down, ending with "You".
  const chain = [...ancestors].reverse();

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card>
        <CardHeader>
          <CardDescription>Sponsor</CardDescription>
          <CardTitle className="flex items-center gap-3 text-lg">
            <UserAvatar name={sponsor.displayName} />
            {sponsor.displayName}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Linked to you</dt>
            <dd>
              <DateTime value={sponsor.attributedAt} style="date" />
            </dd>
            <dt className="text-muted-foreground">Member since</dt>
            <dd>
              <DateTime value={sponsor.joinedAt} style="date" />
            </dd>
            <dt className="text-muted-foreground">How</dt>
            <dd>
              {sponsor.attributionSource === 'ADMIN_CORRECTION' ? (
                <ToneBadge tone="info" dot={false}>
                  <ShieldCheck className="size-3" aria-hidden />
                  Administrator correction
                </ToneBadge>
              ) : (
                <ToneBadge tone="neutral" dot={false}>
                  Registration with referral link
                </ToneBadge>
              )}
            </dd>
          </dl>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardContent>
          <SectionHeader
            title="Upline"
            description={`${ancestors.length} level${ancestors.length === 1 ? '' : 's'} above you${hasMoreAncestors ? ' (the first 10 are shown)' : ''}.`}
          />
          <nav aria-label="Your upline">
            <ol className="flex flex-wrap items-center gap-1.5 text-sm">
              {hasMoreAncestors ? (
                <li className="flex items-center gap-1.5 text-muted-foreground">
                  <span aria-label="More levels above">…</span>
                  <ChevronRight className="size-3.5" aria-hidden />
                </li>
              ) : null}
              {chain.map((a) => (
                <li key={a.depth} className="flex items-center gap-1.5">
                  <span
                    className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1"
                    title={`Level ${a.depth} above you`}
                  >
                    <span className="text-xs text-muted-foreground tabular-nums">L{a.depth}</span>
                    {a.displayName}
                  </span>
                  <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />
                </li>
              ))}
              <li aria-current="page">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 font-medium text-primary">
                  <UserRound className="size-3.5" aria-hidden />
                  You
                </span>
              </li>
            </ol>
          </nav>
          <p className="mt-4 text-xs text-muted-foreground">
            Your sponsor and upline can see your first name, last initial, join date and whether you
            hold an active enrollment — never your email, phone, purchases or rewards.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
