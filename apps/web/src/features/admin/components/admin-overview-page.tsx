'use client';

import {
  AlertTriangle,
  ClipboardCheck,
  Flag,
  Gift,
  Layers,
  ReceiptText,
  RefreshCw,
  Scale,
  Users,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Permission, type AmountBucketDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { RelativeTime } from '@/components/app/date-time';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader, SectionHeader } from '@/components/app/page-header';
import { StatCard } from '@/components/app/stat-card';
import { CardSkeleton, StatGridSkeleton } from '@/components/app/states';
import { ToneBadge } from '@/components/app/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { routes } from '@/config/routes';
import { useSession } from '@/hooks/use-session';

import { useAdminOverview } from '../api';
import { ActivityCharts } from './activity-charts';
import { RecentActionsCard } from './recent-actions-card';

/** Admin console home: work queues, platform KPIs, 30-day activity and recent admin actions. */
export function AdminOverviewPage() {
  const { data, isPending, error, refetch, isFetching } = useAdminOverview();
  const { can, canAny } = useSession();

  if (isPending) return <OverviewSkeleton />;
  if (error || !data) {
    return (
      <>
        <PageHeader title="Overview" />
        <ErrorState error={error} onRetry={() => void refetch()} />
      </>
    );
  }

  const scoped = data.scope === 'PROGRAMS';
  const link = (allowed: boolean, href: string, label: string): ReactNode =>
    allowed ? (
      <Link href={href} className="font-medium text-primary hover:underline">
        {label}
      </Link>
    ) : undefined;

  return (
    <div className="space-y-8">
      <PageHeader
        className="mb-0"
        title="Overview"
        description={
          scoped
            ? `Figures for the ${data.scopedProgramCount ?? 0} program${data.scopedProgramCount === 1 ? '' : 's'} assigned to you.`
            : 'Platform-wide figures, pending work and recent changes.'
        }
        meta={
          <span className="text-xs text-muted-foreground">
            Updated <RelativeTime value={data.generatedAt} />
          </span>
        }
        actions={
          <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
            {isFetching ? <Spinner aria-hidden /> : <RefreshCw aria-hidden />}
            Refresh
          </Button>
        }
      />

      {data.deadOutboxMessages ? (
        <Alert role="status" className="border-warning/30 bg-warning/10 text-foreground">
          <AlertTriangle className="text-warning" aria-hidden />
          <AlertTitle>
            {data.deadOutboxMessages} outbound message{data.deadOutboxMessages === 1 ? '' : 's'} could not be delivered
          </AlertTitle>
          <AlertDescription className="text-muted-foreground">
            Emails or notifications failed permanently after retries. Check the worker logs and SMTP settings.
          </AlertDescription>
        </Alert>
      ) : null}

      <section aria-labelledby="queues-heading">
        <SectionHeader title={<span id="queues-heading">Needs attention</span>} description="Work waiting for an administrator." />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Pending reward approvals"
            icon={Gift}
            value={data.pendingRewardApprovals.count.toLocaleString()}
            hint={<BucketList buckets={data.pendingRewardApprovals.byUnit} empty="Nothing to review" />}
            footer={link(
              canAny([Permission.RewardsApprove, Permission.RewardsRead]),
              `${routes.admin.rewards}?status=PENDING_APPROVAL`,
              'Review rewards',
            )}
          />
          <StatCard
            label="Pending enrollments"
            icon={ClipboardCheck}
            value={data.pendingEnrollments.toLocaleString()}
            hint={data.pendingEnrollments > 0 ? 'Awaiting activation or rejection' : 'Nothing to review'}
            footer={link(can(Permission.EnrollmentsManage), `${routes.admin.enrollments}?status=PENDING`, 'Open queue')}
          />
          <StatCard
            label="Reconciliation exceptions"
            icon={Scale}
            value={
              <span className="inline-flex items-center gap-2">
                {data.reconciliation.exceptionCount.toLocaleString()}
                {data.reconciliation.exceptionCount > 0 ? <ToneBadge tone="warning">Investigate</ToneBadge> : null}
              </span>
            }
            hint={data.reconciliation.exceptionCount > 0 ? 'Rewards, ledger or events disagree' : 'Ledger and rewards agree'}
            footer={link(can(Permission.ReconciliationRead), routes.admin.reconciliation, 'Open report')}
          />
          {data.openFlags !== null ? (
            <StatCard
              label="Open flags"
              icon={Flag}
              value={data.openFlags.toLocaleString()}
              hint={data.openFlags > 0 ? 'Suspicious-activity signals to review' : 'No open signals'}
              footer={link(can(Permission.FlagsManage), routes.admin.flags, 'Review flags')}
            />
          ) : (
            <StatCard
              label="Active programs"
              icon={Layers}
              value={data.activePrograms.toLocaleString()}
              hint="Accepting enrollments and sales"
              footer={link(can(Permission.ProgramsRead), routes.admin.programs, 'Programs')}
            />
          )}
        </div>
      </section>

      <section aria-labelledby="platform-heading">
        <SectionHeader title={<span id="platform-heading">{scoped ? 'Your programs' : 'Platform'}</span>} />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label={scoped ? 'Enrolled members' : 'Members'}
            icon={Users}
            value={data.users.total.toLocaleString()}
            hint={`${data.users.verified.toLocaleString()} verified · ${data.users.suspended.toLocaleString()} suspended`}
            footer={link(can(Permission.MembersRead), routes.admin.members, 'Members')}
          />
          {data.openFlags !== null ? (
            <StatCard
              label="Active programs"
              icon={Layers}
              value={data.activePrograms.toLocaleString()}
              hint="Accepting enrollments and sales"
              footer={link(can(Permission.ProgramsRead), routes.admin.programs, 'Programs')}
            />
          ) : null}
          <StatCard
            label="Qualifying sales · 30 days"
            icon={ReceiptText}
            value={data.sales30d.count.toLocaleString()}
            hint={
              <BucketList
                currency
                buckets={data.sales30d.byCurrency.map((b) => ({ ...b, rewardUnit: 'MONEY' as const }))}
                empty="No sales recorded"
              />
            }
            footer={link(canAny([Permission.EventsWrite, Permission.EventsReverse]), routes.admin.events, 'Events')}
          />
          <StatCard
            label="Posted rewards"
            icon={Wallet}
            value={
              data.postedRewards[0] ? (
                <Amount
                  value={data.postedRewards[0].amountMinor}
                  format={{ unit: data.postedRewards[0].rewardUnit, currencyCode: data.postedRewards[0].currencyCode }}
                />
              ) : (
                '0'
              )
            }
            hint={
              data.postedRewards.length > 1 ? (
                <BucketList buckets={data.postedRewards.slice(1)} empty="" />
              ) : data.postedRewards[0] ? (
                `${data.postedRewards[0].count.toLocaleString()} rewards, net of reversals`
              ) : (
                'No rewards posted yet'
              )
            }
            footer={link(can(Permission.LedgerRead), routes.admin.ledger, 'Ledger')}
          />
        </div>
      </section>

      <ActivityCharts daily={data.daily} />

      <RecentActionsCard items={data.recentActions} scoped={scoped} />
    </div>
  );
}

/** Amounts per unit/currency, never summed across them ("₹1,200.00 · 3,000 Points"). */
function BucketList({
  buckets,
  empty,
  currency = false,
}: {
  buckets: readonly AmountBucketDto[];
  empty: string;
  currency?: boolean;
}) {
  if (buckets.length === 0) return <>{empty}</>;
  return (
    <span className="inline-flex flex-wrap gap-x-1.5">
      {buckets.map((b, i) => (
        <span key={`${b.rewardUnit}:${b.currencyCode}`}>
          {i > 0 ? <span aria-hidden>· </span> : null}
          {currency ? (
            <Amount kind="currency" value={b.amountMinor} format={{ currencyCode: b.currencyCode }} />
          ) : (
            <Amount value={b.amountMinor} format={{ unit: b.rewardUnit, currencyCode: b.currencyCode }} />
          )}
        </span>
      ))}
    </span>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-8" role="status" aria-label="Loading overview">
      <div className="space-y-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <StatGridSkeleton />
      <StatGridSkeleton />
      <CardSkeleton lines={6} />
    </div>
  );
}

