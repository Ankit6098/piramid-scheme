'use client';

import { CircleAlert, FileQuestion, History, Info, RotateCcw, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Permission, type SaleEventDetailDto, type SaleProgramOptionDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { CopyButton } from '@/components/app/copy-button';
import { DateTime } from '@/components/app/date-time';
import { ErrorState } from '@/components/app/error-state';
import { EmptyState } from '@/components/app/states';
import { StatusBadge, ToneBadge } from '@/components/app/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '@/hooks/use-session';
import { isApiError } from '@/lib/api-client';
import { enumLabel } from '@/lib/enum-labels';

import { PlanPaymentAlert } from '../../finance/components/plan-payment-alert';
import { useSaleEvent } from '../api';
import { outcomeMeta, pluralize, programCurrencyFormat, programRewardFormat } from '../labels';
import { isUuid } from '../use-event-filters';
import { RevisionBadge } from './event-columns';
import { EventCalculation } from './event-calculation';
import { EventRewards } from './event-rewards';
import { DetailSection, Fact } from './detail-section';
import { RejectPendingSaleDialog } from './reject-pending-sale-dialog';
import { ReverseSaleDialog } from './reverse-sale-dialog';

export interface EventDetailSheetProps {
  /** Id from the `?event=` URL param (null = closed). */
  eventId: string | null;
  onClose: () => void;
  /** Href that opens another sale (revision) in the drawer. */
  eventHref: (id: string) => string;
  /** Opens "Record sale" prefilled from this (rejected/reversed) sale. */
  onReRecord: (event: SaleEventDetailDto) => void;
  programs: readonly SaleProgramOptionDto[] | undefined;
}

/** Rewards that still count for a sale. */
const LIVE_REWARD_STATUSES: ReadonlySet<string> = new Set(['PENDING_APPROVAL', 'APPROVED', 'POSTED']);

function DetailSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading sale">
      <div className="grid grid-cols-2 gap-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-4 w-32" />
          </div>
        ))}
      </div>
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

function EventFacts({ event }: { event: SaleEventDetailDto }) {
  const tz = event.program.timezone;
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      <Fact label="Program">
        {event.program.name}{' '}
        <span className="font-mono text-xs text-muted-foreground">{event.program.code}</span>
      </Fact>
      <Fact label="Sale type">{enumLabel('QualifyingEventType', event.type)}</Fact>
      <Fact label="Amount">
        <Amount
          kind="currency"
          value={event.amountMinor}
          format={programCurrencyFormat(event.program, event.currencyCode)}
          className="font-medium"
        />
      </Fact>
      <Fact label="Source">{enumLabel('QualifyingEventSource', event.source)}</Fact>
      <Fact label="Member credited">
        <span className="block">{event.subject.fullName}</span>
        <span className="inline-flex items-center gap-1">
          <code className="truncate font-mono text-xs text-muted-foreground">
            {event.subject.id}
          </code>
          <CopyButton value={event.subject.id} label="member ID" variant="ghost" size="icon-xs" />
        </span>
      </Fact>
      <Fact label="End-customer reference">
        <span className="inline-flex items-center gap-1">
          <code className="font-mono text-sm">{event.customerReference}</code>
          <CopyButton
            value={event.customerReference}
            label="customer reference"
            variant="ghost"
            size="icon-xs"
          />
        </span>
      </Fact>
      <Fact label="Occurred at">
        <DateTime value={event.occurredAt} timeZone={tz} showTimeZone />
      </Fact>
      <Fact label="Recorded at">
        <DateTime value={event.createdAt} timeZone={tz} showTimeZone />
      </Fact>
      <Fact label={event.apiClient ? 'API client' : 'Recorded by'}>
        {event.apiClient ? (
          <>
            {event.apiClient.name}{' '}
            <code className="font-mono text-xs text-muted-foreground">
              {event.apiClient.keyPrefix}…
            </code>
          </>
        ) : (
          (event.recordedBy?.fullName ?? <span className="text-muted-foreground">—</span>)
        )}
      </Fact>
      <Fact label="Policy version">
        {event.policyVersion !== null ? (
          `Version ${event.policyVersion}`
        ) : (
          <span className="text-muted-foreground">Not bound</span>
        )}
      </Fact>
      {event.processedAt ? (
        <Fact label="Processed at">
          <DateTime value={event.processedAt} timeZone={tz} showTimeZone />
        </Fact>
      ) : null}
      <Fact label="Rewards">
        {event.rewardCount > 0 ? (
          <>
            {pluralize(event.rewardCount, 'reward')} ·{' '}
            <Amount value={event.rewardTotalMinor} format={programRewardFormat(event.program)} />
          </>
        ) : (
          <span className="text-muted-foreground">None</span>
        )}
      </Fact>
      {event.description ? (
        <Fact label="Description" className="sm:col-span-2">
          <span className="whitespace-pre-line">{event.description}</span>
        </Fact>
      ) : null}
    </dl>
  );
}

function StatusAlerts({
  event,
  eventHref,
}: {
  event: SaleEventDetailDto;
  eventHref: (id: string) => string;
}) {
  const tz = event.program.timezone;
  return (
    <>
      {event.status === 'REJECTED' ? (
        <Alert variant="destructive" className="border-destructive/40 bg-destructive/5">
          <CircleAlert aria-hidden />
          <AlertTitle>Rejected — no rewards were created</AlertTitle>
          <AlertDescription>
            <p className="font-medium text-destructive">
              {event.rejectionReason ?? 'No reason was recorded.'}
            </p>
            <p>The sale is kept for the record. Correct the details and re-record it if needed.</p>
          </AlertDescription>
        </Alert>
      ) : null}
      {event.status === 'REVERSED' ? (
        <Alert variant="destructive" className="border-destructive/40">
          <Undo2 aria-hidden />
          <AlertTitle>
            Reversed
            {event.reversedAt ? (
              <>
                {' '}
                on <DateTime value={event.reversedAt} timeZone={tz} />
              </>
            ) : null}
          </AlertTitle>
          <AlertDescription>
            <p className="font-medium text-destructive">
              {event.reversalReason ?? 'No reason was recorded.'}
            </p>
            <p>Every reward of this sale was rejected or reversed in the ledger.</p>
          </AlertDescription>
        </Alert>
      ) : null}
      {event.status === 'RECEIVED' ? (
        <Alert role="status">
          <Info aria-hidden />
          <AlertTitle>Rewards are being calculated</AlertTitle>
          <AlertDescription>
            The sale is stored; the reward engine processes it within a couple of minutes. If it
            stays here, a reviewer with the reverse-sales permission can reject it so it can be
            re-recorded.
          </AlertDescription>
        </Alert>
      ) : null}
      {event.status !== 'REJECTED' && event.status !== 'REVERSED' ? (
        <PlanPaymentAlert
          compliance={event.compliance}
          minorUnits={event.program.currencyMinorUnits}
          timeZone={tz}
        />
      ) : null}
      {event.supersededByEventId ? (
        <Alert role="note">
          <History aria-hidden />
          <AlertTitle>A newer revision supersedes this sale</AlertTitle>
          <AlertDescription>
            <Link href={eventHref(event.supersededByEventId)} replace scroll={false}>
              Open the latest revision
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

function Revisions({
  event,
  eventHref,
}: {
  event: SaleEventDetailDto;
  eventHref: (id: string) => string;
}) {
  if (event.revisions.length <= 1) return null;
  return (
    <DetailSection
      title="Revisions"
      description="Every recording of this external id, oldest first. A rejected or reversed sale can be re-recorded as a new revision."
    >
      <ol className="divide-y rounded-lg border text-sm">
        {event.revisions.map((revision) => {
          const current = revision.id === event.id;
          return (
            <li key={revision.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <span className="w-12 shrink-0 font-medium tabular-nums">rev {revision.revision}</span>
              <StatusBadge kind="QualifyingEventStatus" value={revision.status} />
              <DateTime
                value={revision.createdAt}
                timeZone={event.program.timezone}
                className="text-xs text-muted-foreground"
              />
              <span className="ml-auto">
                {current ? (
                  <span className="text-xs font-medium text-muted-foreground" aria-current="true">
                    Viewing
                  </span>
                ) : (
                  <Link
                    href={eventHref(revision.id)}
                    replace
                    scroll={false}
                    className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                  >
                    Open revision {revision.revision}
                  </Link>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </DetailSection>
  );
}

function EventBody({
  event,
  eventHref,
}: {
  event: SaleEventDetailDto;
  eventHref: (id: string) => string;
}) {
  return (
    <div className="space-y-6">
      <StatusAlerts event={event} eventHref={eventHref} />
      <DetailSection title="Sale">
        <EventFacts event={event} />
      </DetailSection>
      <Revisions event={event} eventHref={eventHref} />
      <Separator />
      {event.calculation ? (
        <EventCalculation
          calculation={event.calculation}
          saleCurrencyCode={event.currencyCode}
          timeZone={event.program.timezone}
        />
      ) : (
        <DetailSection title="Calculation">
          <p className="text-sm text-muted-foreground">
            {event.status === 'RECEIVED'
              ? 'Not calculated yet.'
              : 'No calculation was made for this sale.'}
          </p>
        </DetailSection>
      )}
      <DetailSection
        title="Rewards"
        description="Rewards from manually recorded sales always need a second person's approval."
      >
        {event.rewards.length > 0 ? (
          <EventRewards
            rewards={event.rewards}
            minorUnits={event.program.currencyMinorUnits}
            timeZone={event.program.timezone}
          />
        ) : (
          <p className="text-sm text-muted-foreground">No rewards were created for this sale.</p>
        )}
      </DetailSection>
    </div>
  );
}

export function EventDetailSheet({
  eventId,
  onClose,
  eventHref,
  onReRecord,
  programs,
}: EventDetailSheetProps) {
  // Keep showing the last sale while the drawer animates closed.
  const [shownId, setShownId] = useState(eventId);
  if (eventId && eventId !== shownId) setShownId(eventId);
  const activeId = eventId ?? shownId;
  const validId = isUuid(activeId) ? activeId : null;
  const query = useSaleEvent(validId);
  const event = query.data;
  const notFound =
    Boolean(activeId) && (!validId || (isApiError(query.error) && query.error.isNotFound));
  // UI gating only — the API authorizes every action.
  const { can, user } = useSession();
  const canReRecordProgram = Boolean(
    event && programs?.some((p) => p.id === event.programId && p.canRecordSales),
  );
  const showReRecord =
    Boolean(event) &&
    (event?.status === 'REJECTED' || event?.status === 'REVERSED') &&
    !event?.supersededByEventId &&
    canReRecordProgram &&
    can(Permission.EventsWrite);
  // A recipient of any live reward of the sale may not reverse it (the API answers 409 OWN_REWARD).
  const holdsLiveReward = Boolean(
    user && event?.rewards.some((r) => r.recipient.id === user.id && LIVE_REWARD_STATUSES.has(r.status)),
  );
  const showReverse = event?.status === 'PROCESSED' && can(Permission.EventsReverse) && !holdsLiveReward;
  const showRejectPending = event?.status === 'RECEIVED' && can(Permission.EventsReverse);

  return (
    <Sheet open={Boolean(eventId)} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent
        side="right"
        className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
      >
        <SheetHeader className="border-b pr-12">
          <SheetTitle className="flex flex-wrap items-center gap-2">
            {event ? (
              <>
                <span className="font-mono">{event.externalId}</span>
                <RevisionBadge revision={event.revision} />
              </>
            ) : (
              'Sale details'
            )}
          </SheetTitle>
          {event ? (
            <>
              <SheetDescription>
                {event.program.name} · {enumLabel('QualifyingEventType', event.type)}
              </SheetDescription>
              <div className="flex flex-wrap items-center gap-2 pt-1.5">
                <StatusBadge kind="QualifyingEventStatus" value={event.status} />
                <ToneBadge tone={outcomeMeta(event.outcome).tone} dot={false}>
                  {outcomeMeta(event.outcome).label}
                </ToneBadge>
              </div>
            </>
          ) : (
            <SheetDescription>Qualifying sale, calculation trace and rewards.</SheetDescription>
          )}
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {notFound ? (
            <EmptyState
              variant="plain"
              icon={FileQuestion}
              title="Sale not found"
              description="It doesn't exist, or it belongs to a program you can't access."
            />
          ) : event ? (
            <EventBody event={event} eventHref={eventHref} />
          ) : query.error ? (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} variant="plain" />
          ) : (
            <DetailSkeleton />
          )}
        </div>

        {event && (showReRecord || showReverse || showRejectPending) ? (
          <SheetFooter className="flex-row flex-wrap justify-end border-t">
            {showReRecord ? (
              <Button variant="outline" onClick={() => onReRecord(event)}>
                <RotateCcw aria-hidden />
                Re-record
              </Button>
            ) : null}
            {showRejectPending ? <RejectPendingSaleDialog event={event} /> : null}
            {showReverse ? <ReverseSaleDialog event={event} /> : null}
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
