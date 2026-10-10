'use client';

import { useQuery } from '@tanstack/react-query';
import { Check, CircleDashed, Undo2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { MemberRewardDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { ErrorState } from '@/components/app/error-state';
import { CardSkeleton } from '@/components/app/states';
import { StatusBadge } from '@/components/app/status-badge';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { api } from '@/lib/api-client';
import { cn } from '@/lib/utils';

import { DetailGrid, DetailItem } from '../../../finance/components/detail';
import { unitFormat } from '../../../finance/lib';
import { financeKeys } from '../../../finance/query-keys';
import { formatCalendarDate } from './member-reward-columns';

export interface MemberRewardSheetProps {
  rewardId: string | undefined;
  /** Row from the list (shown immediately; the detail request refreshes it). */
  initial?: MemberRewardDto;
  onOpenChange: (open: boolean) => void;
}

/** One of the member's rewards: amount, status and the decision timeline. */
export function MemberRewardSheet({ rewardId, initial, onOpenChange }: MemberRewardSheetProps) {
  const query = useQuery({
    queryKey: financeKeys.member.detail(rewardId ?? 'none'),
    queryFn: ({ signal }) => api.get<MemberRewardDto>(`/users/me/rewards/${encodeURIComponent(rewardId!)}`, { signal }),
    enabled: Boolean(rewardId),
    ...(initial ? { initialData: initial } : {}),
  });
  const reward = query.data;

  return (
    <Sheet open={Boolean(rewardId)} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Reward details</SheetTitle>
          <SheetDescription>{reward ? reward.program.name : 'Loading…'}</SheetDescription>
        </SheetHeader>
        <div className="space-y-6 px-4 pb-6">
          {query.isPending ? (
            <CardSkeleton lines={4} />
          ) : query.error && !reward ? (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} variant="plain" />
          ) : reward ? (
            <>
              <div className="flex items-end justify-between gap-3">
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Amount</p>
                  <Amount value={reward.amountMinor} format={unitFormat(reward)} className="font-heading text-2xl font-semibold" />
                </div>
                <StatusBadge kind="RewardStatus" value={reward.status} />
              </div>
              <DetailGrid>
                <DetailItem label="Program">{reward.program.name}</DetailItem>
                <DetailItem label="Level">Level {reward.level}</DetailItem>
              </DetailGrid>
              <section className="space-y-3" aria-label="Timeline">
                <h3 className="text-sm font-semibold">Timeline</h3>
                <ol className="space-y-3">
                  <TimelineItem icon={<CircleDashed aria-hidden />} title="Recorded" date={reward.createdDate}>
                    Calculated from a qualifying sale.
                  </TimelineItem>
                  {reward.status === 'PENDING_APPROVAL' ? (
                    <TimelineItem icon={<CircleDashed aria-hidden />} title="Waiting for approval" muted>
                      A reviewer will approve or reject it.
                    </TimelineItem>
                  ) : null}
                  {reward.approvedDate ? <TimelineItem icon={<Check aria-hidden />} title="Approved" date={reward.approvedDate} /> : null}
                  {reward.postedDate ? (
                    <TimelineItem icon={<Check aria-hidden />} title="Posted" date={reward.postedDate} tone="success">
                      Added to your earnings.
                    </TimelineItem>
                  ) : null}
                  {reward.rejectedDate ? (
                    <TimelineItem icon={<X aria-hidden />} title="Rejected" date={reward.rejectedDate} tone="destructive">
                      {reward.rejectionReason ?? 'Not approved.'}
                    </TimelineItem>
                  ) : null}
                  {reward.reversedDate ? (
                    <TimelineItem icon={<Undo2 aria-hidden />} title="Reversed" date={reward.reversedDate} tone="destructive">
                      {reward.reversalReason ?? 'Removed from your earnings.'}
                    </TimelineItem>
                  ) : null}
                </ol>
              </section>
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function TimelineItem({
  icon,
  title,
  date,
  children,
  tone,
  muted,
}: {
  icon: ReactNode;
  title: string;
  date?: string | null;
  children?: ReactNode;
  tone?: 'success' | 'destructive';
  muted?: boolean;
}) {
  return (
    <li className="flex gap-3">
      <span
        className={cn(
          'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-3.5',
          tone === 'success' && 'bg-success/10 text-success',
          tone === 'destructive' && 'bg-destructive/10 text-destructive',
        )}
      >
        {icon}
      </span>
      <div className={cn('min-w-0 space-y-0.5', muted && 'text-muted-foreground')}>
        <p className="text-sm font-medium">
          {title}
          {date ? <span className="ml-2 font-normal text-muted-foreground">{formatCalendarDate(date)}</span> : null}
        </p>
        {children ? <p className="text-xs break-words text-muted-foreground">{children}</p> : null}
      </div>
    </li>
  );
}
