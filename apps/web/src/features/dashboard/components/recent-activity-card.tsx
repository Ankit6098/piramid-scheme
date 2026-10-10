'use client';

import { Activity, Gift } from 'lucide-react';
import Link from 'next/link';
import type { MemberDashboardActivityDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { RelativeTime } from '@/components/app/date-time';
import { EmptyState } from '@/components/app/states';
import { StatusBadge } from '@/components/app/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { routes } from '@/config/routes';
import { notificationMeta } from '@/features/notifications/notification-meta';
import { cn } from '@/lib/utils';

/** Latest reward status changes and notifications (privacy-safe: no sale or customer details). */
export function RecentActivityCard({ items }: { items: readonly MemberDashboardActivityDto[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent activity</CardTitle>
        <CardDescription>Reward updates and messages about your account.</CardDescription>
        <CardAction>
          <Button asChild variant="ghost" size="sm">
            <Link href={routes.member.notifications}>All notifications</Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <EmptyState
            variant="plain"
            size="sm"
            icon={Activity}
            title="Nothing here yet"
            description="Reward updates from qualifying sales and account messages will show up here."
          />
        ) : (
          <ol className="relative space-y-4">
            {items.map((item) => (
              <li key={item.id} className="flex gap-3">
                {item.kind === 'REWARD' ? <RewardRow item={item} /> : <NotificationRow item={item} />}
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function IconBubble({ children, accent }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <span
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-full',
        accent ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
      )}
    >
      {children}
    </span>
  );
}

function RewardRow({ item }: { item: Extract<MemberDashboardActivityDto, { kind: 'REWARD' }> }) {
  return (
    <>
      <IconBubble accent>
        <Gift className="size-4" aria-hidden />
      </IconBubble>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p className="text-sm font-medium">
            Level {item.level} reward · <span className="text-muted-foreground">{item.programName}</span>
          </p>
          <Amount
            value={item.amountMinor}
            format={{ unit: item.rewardUnit, currencyCode: item.currencyCode }}
            className="text-sm font-medium"
          />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <StatusBadge kind="RewardStatus" value={item.status} />
          <RelativeTime value={item.at} />
          <Link href={routes.member.rewards} className="font-medium text-primary hover:underline">
            View rewards
          </Link>
        </div>
      </div>
    </>
  );
}

function NotificationRow({ item }: { item: Extract<MemberDashboardActivityDto, { kind: 'NOTIFICATION' }> }) {
  const meta = notificationMeta(item.type);
  const Icon = meta.icon;
  return (
    <>
      <IconBubble accent={!item.read}>
        <Icon className="size-4" aria-hidden />
      </IconBubble>
      <div className="min-w-0 flex-1">
        <p className={cn('text-sm', item.read ? 'font-medium' : 'font-semibold')}>
          {item.title}
          {!item.read ? <span className="sr-only"> (unread)</span> : null}
        </p>
        <p className="line-clamp-2 text-sm text-muted-foreground">{item.body}</p>
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span>{meta.category}</span>
          <span aria-hidden>·</span>
          <RelativeTime value={item.at} />
        </div>
      </div>
    </>
  );
}
