'use client';

import { BellRing, ClipboardList, Layers, Megaphone, MailWarning, Network, UserPlus, X } from 'lucide-react';
import Link from 'next/link';
import type { MemberDashboardDto, NotificationDto } from '@app/shared';

import { DateTime } from '@/components/app/date-time';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { StatCard } from '@/components/app/stat-card';
import { CardSkeleton, EmptyState, StatGridSkeleton } from '@/components/app/states';
import { StatusBadge } from '@/components/app/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { routes } from '@/config/routes';
import { useMarkNotificationRead } from '@/features/notifications/api';
import { ReferralLinkCard } from '@/features/referrals/components/referral-link-card';
import { EarningsSummary } from '@/features/rewards/components/earnings-summary';

import { useMemberDashboard } from '../api';
import { RecentActivityCard } from './recent-activity-card';

/** The member home: greeting, verification banner, announcements, KPIs, enrollments, activity. */
export function MemberDashboardPage() {
  const { data, isPending, error, refetch } = useMemberDashboard();

  if (isPending) return <DashboardSkeleton />;
  if (error || !data) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <ErrorState error={error} onRetry={() => void refetch()} />
      </>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        className="mb-0"
        title={`Welcome back, ${data.user.firstName}`}
        description="Your programs, team and recorded rewards at a glance."
      />

      <VerificationBanner user={data.user} />
      <Announcements items={data.announcements} />

      <section aria-label="Key figures" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Active enrollments"
          icon={Layers}
          value={data.enrollments.active.toLocaleString()}
          hint={
            data.enrollments.pending > 0
              ? `${data.enrollments.pending} awaiting activation`
              : 'Programs you currently take part in'
          }
          footer={<FooterLink href={routes.member.programs}>Browse programs</FooterLink>}
        />
        <StatCard
          label="Direct referrals"
          icon={UserPlus}
          value={data.referrals.directCount.toLocaleString()}
          hint="Members who joined with your link"
          footer={<FooterLink href={routes.member.referrals}>Your referral link</FooterLink>}
        />
        <StatCard
          label="Team size"
          icon={Network}
          value={data.referrals.teamSize.toLocaleString()}
          hint="Members in your network, up to 10 levels"
          footer={<FooterLink href={routes.member.team}>View team</FooterLink>}
        />
        <StatCard
          label="Unread notifications"
          icon={BellRing}
          value={data.unreadNotifications.toLocaleString()}
          hint={data.unreadNotifications > 0 ? 'New messages for you' : "You're all caught up"}
          footer={<FooterLink href={routes.member.notifications}>Open inbox</FooterLink>}
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <EnrollmentsCard enrollments={data.enrollments} />
          <RecentActivityCard items={data.recentActivity} />
        </div>
        <aside className="space-y-6" aria-label="Rewards and referral link">
          <Card>
            <CardHeader>
              <CardTitle>Rewards</CardTitle>
              <CardDescription>
                Recorded rewards from qualifying sales of approved offerings.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <EarningsSummary variant="compact" />
              <Button asChild variant="outline" size="sm" className="w-full">
                <Link href={routes.member.rewards}>Reward history</Link>
              </Button>
            </CardContent>
          </Card>
          <ReferralLinkCard compact />
        </aside>
      </div>
    </div>
  );
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="font-medium text-primary hover:underline">
      {children}
    </Link>
  );
}

function VerificationBanner({ user }: { user: MemberDashboardDto['user'] }) {
  if (user.emailVerified && user.status === 'ACTIVE') return null;
  return (
    <Alert role="status" className="border-warning/30 bg-warning/10 text-foreground">
      <MailWarning className="text-warning" aria-hidden />
      <AlertTitle>{user.emailVerified ? 'Your account is not active' : 'Verify your email address'}</AlertTitle>
      <AlertDescription className="text-muted-foreground">
        {user.emailVerified
          ? 'Some features are unavailable until an administrator reactivates your account.'
          : 'Confirm your email address to enroll in programs and use your referral link.'}{' '}
        <Link href={routes.member.profile} className="font-medium text-primary hover:underline">
          Go to profile
        </Link>
      </AlertDescription>
    </Alert>
  );
}

function Announcements({ items }: { items: readonly NotificationDto[] }) {
  const markRead = useMarkNotificationRead();
  if (items.length === 0) return null;
  return (
    <section aria-label="Announcements" className="space-y-2">
      {items.map((n) => (
        <Alert key={n.id} role="status" className="border-info/30 bg-info/10 pr-12 text-foreground">
          <Megaphone className="text-info" aria-hidden />
          <AlertTitle>{n.title}</AlertTitle>
          <AlertDescription className="whitespace-pre-line text-muted-foreground">{n.body}</AlertDescription>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute top-1.5 right-1.5"
            aria-label={`Dismiss announcement: ${n.title}`}
            onClick={() => markRead.mutate(n.id)}
            disabled={markRead.isPending}
          >
            <X aria-hidden />
          </Button>
        </Alert>
      ))}
    </section>
  );
}

function EnrollmentsCard({ enrollments }: { enrollments: MemberDashboardDto['enrollments'] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Your enrollments</CardTitle>
        <CardDescription>Active plans and enrollments awaiting activation.</CardDescription>
        <CardAction>
          <Button asChild variant="ghost" size="sm">
            <Link href={routes.member.programs}>Programs</Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {enrollments.items.length === 0 ? (
          <EmptyState
            variant="plain"
            size="sm"
            icon={ClipboardList}
            title="No enrollments yet"
            description="Browse the available programs to see their plans and terms."
            action={
              <Button asChild size="sm">
                <Link href={routes.member.programs}>Browse programs</Link>
              </Button>
            }
          />
        ) : (
          <ul className="divide-y">
            {enrollments.items.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{e.program.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {e.optionName}
                    {e.status === 'ACTIVE' && e.effectiveTo ? (
                      <>
                        {' · covered until '}
                        <DateTime value={e.effectiveTo} style="date" />
                      </>
                    ) : null}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge kind="EnrollmentStatus" value={e.status} />
                  {e.status === 'ACTIVE' ? <StatusBadge kind="EligibilityStatus" value={e.eligibilityStatus} /> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading dashboard">
      <div className="space-y-2">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <StatGridSkeleton />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <CardSkeleton lines={4} />
          <CardSkeleton lines={5} />
        </div>
        <div className="space-y-6">
          <CardSkeleton lines={2} />
          <CardSkeleton lines={2} />
        </div>
      </div>
    </div>
  );
}
