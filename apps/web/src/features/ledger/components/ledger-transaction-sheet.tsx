'use client';

import Link from 'next/link';

import { Amount } from '@/components/app/amount';
import { CopyButton } from '@/components/app/copy-button';
import { DateTime } from '@/components/app/date-time';
import { ErrorState } from '@/components/app/error-state';
import { CardSkeleton } from '@/components/app/states';
import { StatusBadge } from '@/components/app/status-badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { routes } from '@/config/routes';

import { DetailGrid, DetailItem, DetailSection } from '../../finance/components/detail';
import { unitFormat } from '../../finance/lib';
import { useLedgerTransaction } from '../api';
import { EntriesTable } from './entries-table';

export interface LedgerTransactionSheetProps {
  transactionId: string | undefined;
  onOpenChange: (open: boolean) => void;
  onOpenTransaction: (id: string) => void;
}

/** One ledger transaction: header, references and its balanced debit/credit entries. */
export function LedgerTransactionSheet({ transactionId, onOpenChange, onOpenTransaction }: LedgerTransactionSheetProps) {
  const query = useLedgerTransaction(transactionId);
  const t = query.data;
  return (
    <Sheet open={Boolean(transactionId)} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        <SheetHeader className="border-b pr-12">
          <SheetTitle className="flex flex-wrap items-center gap-2">
            Ledger transaction
            {t ? <StatusBadge kind="LedgerTransactionType" value={t.type} /> : null}
          </SheetTitle>
          <SheetDescription>{t ? <DateTime value={t.postedAt} style="long" /> : 'Loading…'}</SheetDescription>
        </SheetHeader>
        <div className="space-y-6 px-4 pb-6">
          {query.isPending ? (
            <CardSkeleton lines={5} />
          ) : query.error ? (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} variant="plain" />
          ) : t ? (
            <>
              <div className="flex flex-wrap items-end justify-between gap-3 rounded-lg border bg-muted/30 px-4 py-3">
                <div>
                  <p className="text-xs text-muted-foreground">Amount</p>
                  <Amount value={t.amountMinor} format={unitFormat(t)} className="font-heading text-2xl font-semibold" />
                </div>
                <p className="text-xs text-muted-foreground">{t.rewardUnit === 'POINTS' ? 'Points' : t.currencyCode}</p>
              </div>

              <DetailSection title="Entries" description="Debits equal credits; the ledger is append-only.">
                <EntriesTable transaction={t} />
              </DetailSection>

              <DetailSection title="References">
                <DetailGrid>
                  <DetailItem label="Member">{t.member.fullName}</DetailItem>
                  <DetailItem label="Program">{t.program.name}</DetailItem>
                  <DetailItem label="Reward">
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <Link
                        href={`${routes.admin.rewards}?tab=ALL&reward=${encodeURIComponent(t.reward.id)}`}
                        className="font-medium text-primary hover:underline"
                      >
                        Level {t.reward.level} reward
                      </Link>
                      <StatusBadge kind="RewardStatus" value={t.reward.status} />
                    </span>
                  </DetailItem>
                  <DetailItem label="Posted by">{t.postedBy?.fullName ?? 'System (automatic approval)'}</DetailItem>
                  {t.reversesTransactionId ? (
                    <DetailItem label="Reverses">
                      <Button variant="link" size="sm" className="h-auto p-0" onClick={() => onOpenTransaction(t.reversesTransactionId!)}>
                        Original posting
                      </Button>
                    </DetailItem>
                  ) : null}
                  {t.reversedByTransactionId ? (
                    <DetailItem label="Reversed by">
                      <Button variant="link" size="sm" className="h-auto p-0" onClick={() => onOpenTransaction(t.reversedByTransactionId!)}>
                        Reversal transaction
                      </Button>
                    </DetailItem>
                  ) : null}
                  {t.description ? (
                    <DetailItem label={t.type === 'REWARD_REVERSAL' ? 'Reason' : 'Description'} className="sm:col-span-2">
                      {t.description}
                    </DetailItem>
                  ) : null}
                  <DetailItem label="Idempotency key" className="sm:col-span-2">
                    <span className="inline-flex items-center gap-1 font-mono text-xs break-all">
                      {t.idempotencyKey}
                      <CopyButton value={t.idempotencyKey} label="idempotency key" variant="ghost" size="icon-xs" />
                    </span>
                  </DetailItem>
                  <DetailItem label="Transaction id" className="sm:col-span-2">
                    <span className="inline-flex items-center gap-1 font-mono text-xs break-all">
                      {t.id}
                      <CopyButton value={t.id} label="transaction id" variant="ghost" size="icon-xs" />
                    </span>
                  </DetailItem>
                </DetailGrid>
              </DetailSection>
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
