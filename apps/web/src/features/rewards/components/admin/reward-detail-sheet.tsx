'use client';

import { Check, ShieldAlert, Undo2, X } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { AdminRewardDetailDto, LedgerTransactionDetailDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { CopyButton } from '@/components/app/copy-button';
import { DateTime } from '@/components/app/date-time';
import { ErrorState } from '@/components/app/error-state';
import { CardSkeleton } from '@/components/app/states';
import { StatusBadge, ToneBadge } from '@/components/app/status-badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { routes } from '@/config/routes';

import { DetailGrid, DetailItem, DetailSection } from '../../../finance/components/detail';
import { EntriesTable } from '../../../ledger/components/entries-table';
import { currencyFormat, unitFormat } from '../../../finance/lib';
import { useAdminReward } from '../../api';
import { auditActionLabel } from '../../labels';
import { approvalBlocker, isPending, type RewardPermissions } from './admin-reward-columns';
import { CalculationTrace } from './calculation-trace';
import type { RewardDecisionKind } from './reward-decision-dialog';

export interface RewardDetailSheetProps {
  rewardId: string | undefined;
  perms: RewardPermissions;
  onOpenChange: (open: boolean) => void;
  onDecide: (reward: AdminRewardDetailDto, kind: RewardDecisionKind) => void;
}

/** Reward detail drawer: summary, sale, readable calculation trace, ledger postings, audit trail. */
export function RewardDetailSheet({ rewardId, perms, onOpenChange, onDecide }: RewardDetailSheetProps) {
  const query = useAdminReward(rewardId);
  const r = query.data;

  return (
    <Sheet open={Boolean(rewardId)} onOpenChange={onOpenChange}>
      <SheetContent className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
        <SheetHeader className="border-b pr-12">
          <SheetTitle className="flex flex-wrap items-center gap-2">
            {r ? (
              <>
                Reward for {r.recipient.fullName}
                <StatusBadge kind="RewardStatus" value={r.status} />
              </>
            ) : (
              'Reward'
            )}
          </SheetTitle>
          <SheetDescription>
            {r ? `${r.program.name} · Level ${r.level} · created ` : 'Loading reward…'}
            {r ? <DateTime value={r.createdAt} /> : null}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 px-4 py-4">
          {query.isPending ? (
            <CardSkeleton lines={6} />
          ) : query.error ? (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} variant="plain" />
          ) : r ? (
            <Tabs defaultValue="overview" className="gap-4">
              <TabsList className="w-full sm:w-fit">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="calculation">Calculation</TabsTrigger>
                <TabsTrigger value="ledger">Ledger ({r.ledgerTransactions.length})</TabsTrigger>
                <TabsTrigger value="audit">Audit</TabsTrigger>
              </TabsList>
              <TabsContent value="overview" className="space-y-6">
                <Overview r={r} />
              </TabsContent>
              <TabsContent value="calculation">
                <CalculationTrace reward={r} />
              </TabsContent>
              <TabsContent value="ledger">
                <LedgerTab transactions={r.ledgerTransactions} status={r.status} />
              </TabsContent>
              <TabsContent value="audit">
                <AuditTab r={r} />
              </TabsContent>
            </Tabs>
          ) : null}
        </div>

        {r ? <Actions r={r} perms={perms} onDecide={onDecide} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function Actions({ r, perms, onDecide }: { r: AdminRewardDetailDto; perms: RewardPermissions; onDecide: RewardDetailSheetProps['onDecide'] }) {
  const pending = isPending(r);
  const blocker = approvalBlocker(r);
  const buttons: ReactNode[] = [];
  if (perms.approve && pending && !blocker) {
    buttons.push(
      <Button key="approve" onClick={() => onDecide(r, 'approve')}>
        <Check aria-hidden />
        Approve and post
      </Button>,
    );
  }
  if (perms.approve && pending && !r.viewer.isRecipient) {
    buttons.push(
      <Button key="reject" variant="destructive" onClick={() => onDecide(r, 'reject')}>
        <X aria-hidden />
        Reject
      </Button>,
    );
  }
  if (perms.reverse && r.status === 'POSTED' && !r.viewer.isRecipient) {
    buttons.push(
      <Button key="reverse" variant="destructive" onClick={() => onDecide(r, 'reverse')}>
        <Undo2 aria-hidden />
        Reverse reward
      </Button>,
    );
  }
  if (perms.reverseEvent && r.event.status === 'PROCESSED') {
    buttons.push(
      <Button key="reverse-event" variant="outline" onClick={() => onDecide(r, 'reverse-event')}>
        <Undo2 aria-hidden />
        Reverse whole sale
      </Button>,
    );
  }
  if (buttons.length === 0 && !(perms.approve && pending && blocker)) return null;
  return (
    <SheetFooter className="sticky bottom-0 border-t bg-popover">
      {perms.approve && pending && blocker ? (
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {blocker}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">{buttons}</div>
    </SheetFooter>
  );
}

function Overview({ r }: { r: AdminRewardDetailDto }) {
  const fmt = unitFormat(r);
  const tz = r.program.timezone;
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3 rounded-lg border bg-muted/30 px-4 py-3">
        <div>
          <p className="text-xs text-muted-foreground">Reward amount</p>
          <Amount value={r.amountMinor} format={fmt} className="font-heading text-2xl font-semibold" />
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <p>
            {r.rewardUnit === 'POINTS' ? 'Points' : r.currencyCode} · Policy v{r.policyVersion.version}
          </p>
          <p>{r.policyVersion.requiresApproval ? 'Manual approval required' : 'Auto-approval policy'}</p>
        </div>
      </div>

      <DetailSection title="Decisions">
        <DetailGrid>
          <DetailItem label="Recipient">{r.recipient.fullName}</DetailItem>
          <DetailItem label="Program">{r.program.name}</DetailItem>
          <DetailItem label="Approved">
            {r.approvedAt ? (
              <>
                <DateTime value={r.approvedAt} /> {r.approvedBy ? `by ${r.approvedBy.fullName}` : '(automatic)'}
              </>
            ) : (
              '—'
            )}
          </DetailItem>
          <DetailItem label="Posted to ledger">{r.postedAt ? <DateTime value={r.postedAt} /> : '—'}</DetailItem>
          {r.rejectedAt ? (
            <DetailItem label="Rejected" className="sm:col-span-2">
              <DateTime value={r.rejectedAt} /> {r.rejectedBy ? `by ${r.rejectedBy.fullName}` : ''}
              {r.rejectionReason ? <span className="block text-muted-foreground">{r.rejectionReason}</span> : null}
            </DetailItem>
          ) : null}
          {r.reversedAt ? (
            <DetailItem label="Reversed" className="sm:col-span-2">
              <DateTime value={r.reversedAt} /> {r.reversedBy ? `by ${r.reversedBy.fullName}` : ''}
              {r.reversalReason ? <span className="block text-muted-foreground">{r.reversalReason}</span> : null}
            </DetailItem>
          ) : null}
        </DetailGrid>
      </DetailSection>

      <DetailSection
        title="Sale"
        description="The qualifying sale that funded this reward."
        actions={
          <Button asChild variant="link" size="sm" className="h-auto p-0">
            <Link href={`${routes.admin.events}?event=${encodeURIComponent(r.event.id)}`}>Open in sales events</Link>
          </Button>
        }
      >
        <DetailGrid>
          <DetailItem label="External id">
            <span className="inline-flex items-center gap-1 font-mono text-xs">
              {r.event.externalId}
              {r.event.revision > 0 ? ` (rev. ${r.event.revision})` : ''}
              <CopyButton value={r.event.externalId} label="external id" variant="ghost" size="icon-xs" />
            </span>
          </DetailItem>
          <DetailItem label="Status">
            <StatusBadge kind="QualifyingEventStatus" value={r.event.status} />
          </DetailItem>
          <DetailItem label="Sale amount">
            <Amount kind="currency" value={r.event.amountMinor} format={currencyFormat(r.event.currencyCode, r.currencyMinorUnits)} />
          </DetailItem>
          <DetailItem label="Occurred">
            <DateTime value={r.event.occurredAt} timeZone={tz} showTimeZone />
          </DetailItem>
          <DetailItem label="Credited member">{r.event.subject.fullName}</DetailItem>
          <DetailItem label="Recorded by">{r.event.recordedBy?.fullName ?? `${r.event.source === 'ADMIN_MANUAL' ? 'Admin' : 'Integration'}`}</DetailItem>
          <DetailItem label="Type / source">
            {r.event.type.replaceAll('_', ' ').toLowerCase()} · {r.event.source.replaceAll('_', ' ').toLowerCase()}
          </DetailItem>
          <DetailItem label="Customer reference">
            <span className="font-mono text-xs">{r.event.customerReference}</span>
          </DetailItem>
          {r.event.reversedAt ? (
            <DetailItem label="Sale reversed" className="sm:col-span-2">
              <DateTime value={r.event.reversedAt} />
              {r.event.reversalReason ? <span className="block text-muted-foreground">{r.event.reversalReason}</span> : null}
            </DetailItem>
          ) : null}
        </DetailGrid>
      </DetailSection>

      {r.siblings.length > 0 ? (
        <DetailSection title="Other rewards from this sale">
          <ul className="divide-y rounded-lg border">
            {r.siblings.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 truncate">
                  <span className="mr-2 text-xs font-semibold text-muted-foreground tabular-nums">L{s.level}</span>
                  {s.recipient.fullName}
                </span>
                <span className="flex items-center gap-2">
                  <Amount value={s.amountMinor} format={unitFormat(s)} />
                  <StatusBadge kind="RewardStatus" value={s.status} />
                </span>
              </li>
            ))}
          </ul>
        </DetailSection>
      ) : null}
    </>
  );
}

function LedgerTab({ transactions, status }: { transactions: LedgerTransactionDetailDto[]; status: string }) {
  if (transactions.length === 0) {
    return (
      <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
        {status === 'REJECTED'
          ? 'Rejected rewards are never posted to the ledger.'
          : 'Nothing has been posted yet. Approving the reward posts it to the ledger.'}
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {transactions.map((t) => (
        <div key={t.id} className="space-y-2 rounded-lg border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <StatusBadge kind="LedgerTransactionType" value={t.type} />
              <DateTime value={t.postedAt} className="text-xs text-muted-foreground" />
            </div>
            <Button asChild variant="link" size="sm" className="h-auto p-0">
              <Link href={`${routes.admin.ledger}?txn=${encodeURIComponent(t.id)}`}>Open in ledger</Link>
            </Button>
          </div>
          <EntriesTable transaction={t} />
          {t.description && t.type === 'REWARD_REVERSAL' ? <p className="text-xs text-muted-foreground">Reason: {t.description}</p> : null}
        </div>
      ))}
    </div>
  );
}

function AuditTab({ r }: { r: AdminRewardDetailDto }) {
  if (r.auditTrail.length === 0) return <p className="text-sm text-muted-foreground">No audit entries yet.</p>;
  return (
    <ol className="relative space-y-4 border-l pl-4">
      {r.auditTrail.map((a) => (
        <li key={a.id} className="space-y-1">
          <span aria-hidden className="absolute -left-1.5 mt-1.5 size-3 rounded-full border-2 border-background bg-muted-foreground/60" />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{auditActionLabel(a.action)}</span>
            {a.resourceType !== 'reward' ? <ToneBadge tone="muted">Sale</ToneBadge> : null}
            <DateTime value={a.createdAt} className="text-xs text-muted-foreground" />
          </div>
          <p className="text-xs text-muted-foreground">
            {a.actor ? a.actor.fullName : 'System'}
            {a.actorRoles.length ? ` · ${a.actorRoles.join(', ').toLowerCase().replaceAll('_', ' ')}` : ''}
          </p>
          {a.reason ? <p className="text-sm break-words">“{a.reason}”</p> : null}
        </li>
      ))}
    </ol>
  );
}
