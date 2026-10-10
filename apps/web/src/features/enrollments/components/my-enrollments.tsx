'use client';

import { CalendarRange, ClipboardList, Hourglass } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import type { MyEnrollmentDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { ConfirmDialog } from '@/components/app/confirm-dialog';
import { useCursorList } from '@/components/app/data-table';
import { DateTime } from '@/components/app/date-time';
import { ErrorState } from '@/components/app/error-state';
import { CardSkeleton, EmptyState } from '@/components/app/states';
import { StatusBadge, ToneBadge } from '@/components/app/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { enumLabel } from '@/lib/enum-labels';
import { queryKeys } from '@/lib/query-keys';

import { MY_ENROLLMENTS_PATH, useCancelMyEnrollment } from '../api';

export interface MyEnrollmentsProps {
  /** Only this program's enrollments (program detail page). */
  programId?: string;
  /** Shown when there are no enrollments. */
  emptyAction?: React.ReactNode;
  /** Compact cards without the program name (inside a program page). */
  compact?: boolean;
}

/** The member's own enrollments with coverage, payment status and cancellation. */
export function MyEnrollments({ programId, emptyAction, compact = false }: MyEnrollmentsProps) {
  const query = programId ? { programId } : {};
  const list = useCursorList<MyEnrollmentDto>({ queryKey: queryKeys.enrollments.mine(query), path: MY_ENROLLMENTS_PATH, query, pageSize: 25 });

  if (list.isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        <CardSkeleton lines={3} />
        <CardSkeleton lines={3} />
      </div>
    );
  }
  if (list.error && list.rows.length === 0) return <ErrorState error={list.error} onRetry={list.refetch} />;
  if (list.rows.length === 0) {
    return (
      <EmptyState
        icon={ClipboardList}
        title="No enrollments yet"
        description="When you enroll in a program plan it shows up here, with its coverage dates and status."
        action={emptyAction}
      />
    );
  }

  return (
    <div className="space-y-4">
      <ul className="grid gap-4 md:grid-cols-2">
        {list.rows.map((e) => (
          <li key={e.id}>
            <EnrollmentCard enrollment={e} compact={compact} />
          </li>
        ))}
      </ul>
      {list.pagination.hasNextPage ? (
        <div className="flex justify-center">
          <Button variant="outline" onClick={list.pagination.fetchNextPage} disabled={list.pagination.isFetchingNextPage}>
            {list.pagination.isFetchingNextPage ? <Spinner aria-hidden /> : null}
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function EnrollmentCard({ enrollment: e, compact }: { enrollment: MyEnrollmentDto; compact: boolean }) {
  const cancel = useCancelMyEnrollment();
  const tz = e.program.timezone;
  const withdrawn = e.status === 'CANCELLED' && e.effectiveFrom !== null && e.effectiveFrom === e.effectiveTo;

  return (
    <Card className="h-full">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="truncate">{compact ? e.option.name : e.program.name}</CardTitle>
            <CardDescription className="truncate">
              {compact ? enumLabel('BillingFrequency', e.option.billingFrequency) : e.option.name} · {e.option.durationDays} days
            </CardDescription>
          </div>
          <div className="flex flex-col items-end gap-1">
            <StatusBadge kind="EnrollmentStatus" value={e.status} />
            {e.upcoming ? <ToneBadge tone="info">Starts later</ToneBadge> : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p>
          <span className="text-muted-foreground">Plan price: </span>
          {e.option.priceMinor === '0' ? (
            'Free'
          ) : (
            <Amount kind="currency" value={e.option.priceMinor} format={{ currencyCode: e.option.currencyCode, minorUnits: e.program.currencyMinorUnits }} />
          )}
        </p>
        {e.status === 'PENDING' ? (
          <p className="flex items-start gap-2 text-muted-foreground">
            <Hourglass className="mt-0.5 size-4 shrink-0" aria-hidden />
            Waiting for the program team to confirm your payment. Payment is arranged offline.
          </p>
        ) : withdrawn ? (
          <p className="text-muted-foreground">Cancelled before it started.</p>
        ) : e.effectiveFrom && e.effectiveTo ? (
          <p className="flex items-center gap-2">
            <CalendarRange className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span>
              <DateTime value={e.effectiveFrom} timeZone={tz} style="date" />
              <span className="text-muted-foreground"> → </span>
              <DateTime value={e.effectiveTo} timeZone={tz} style="date" />
            </span>
          </p>
        ) : null}
        {e.statusReason && (e.status === 'REJECTED' || e.status === 'CANCELLED') ? (
          <p className="rounded-md bg-muted/60 px-2.5 py-1.5 text-xs">{e.statusReason}</p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          {!compact ? (
            <Button variant="link" size="sm" asChild className="px-0">
              <Link href={`/programs/${encodeURIComponent(e.program.code)}`}>View program</Link>
            </Button>
          ) : (
            <span />
          )}
          {e.canCancel ? (
            <ConfirmDialog
              trigger={
                <Button variant="ghost" size="sm" className="text-destructive">
                  Cancel enrollment
                </Button>
              }
              title="Cancel this enrollment?"
              description={
                e.status === 'PENDING'
                  ? 'Your request is withdrawn. You can enroll again later.'
                  : e.upcoming
                    ? 'This queued period is withdrawn before it starts.'
                    : 'Your coverage ends now. Refunds, if any, are handled offline by the program team.'
              }
              confirmLabel="Cancel enrollment"
              cancelLabel="Keep it"
              variant="destructive"
              reason={{ required: false, label: 'Note (optional)', placeholder: 'Anything the program team should know' }}
              onConfirm={async ({ reason }) => {
                await cancel.mutateAsync({ id: e.id, reason });
                toast.success('Enrollment cancelled');
              }}
            />
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
