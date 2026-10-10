'use client';

import { Undo2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { SaleEventDetailDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { ConfirmDialog } from '@/components/app/confirm-dialog';
import { Button } from '@/components/ui/button';
import { createIdempotencyKey } from '@/lib/api-client';

import { useReverseSale } from '../api';
import { pluralize, programCurrencyFormat, programRewardFormat } from '../labels';

/**
 * Refund / chargeback of a processed sale (business rules §9): every reward of the sale is rejected
 * (not yet posted) or reversed with a compensating ledger entry, in one transaction.
 */
export function ReverseSaleDialog({ event }: { event: SaleEventDetailDto }) {
  const [open, setOpen] = useState(false);
  // One Idempotency-Key per dialog open: a retry after a network error reuses it.
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const reverse = useReverseSale();

  function handleOpenChange(next: boolean) {
    if (next) setIdempotencyKey(createIdempotencyKey());
    setOpen(next);
  }

  return (
    <>
      <Button variant="destructive" onClick={() => handleOpenChange(true)}>
        <Undo2 aria-hidden />
        Reverse sale
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={handleOpenChange}
        variant="destructive"
        title={`Reverse sale ${event.externalId}?`}
        description="Use this for a refund or chargeback of the whole sale. This can't be undone."
        reason={{
          label: 'Reason',
          placeholder: 'e.g. Full refund issued to the customer on 12 Oct (ticket #4821).',
          description: 'At least 10 characters. Recorded in the audit log and shown on every reward.',
        }}
        typedConfirmation="REVERSE"
        confirmLabel="Reverse sale"
        onConfirm={async ({ reason }) => {
          await reverse.mutateAsync({
            eventId: event.id,
            reason: reason ?? '',
            idempotencyKey: idempotencyKey ?? createIdempotencyKey(),
          });
          toast.success('Sale reversed', {
            description: 'Its rewards were rejected or reversed in the ledger.',
          });
        }}
      >
        <div className="space-y-3">
          <dl className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/30 p-3">
            <div>
              <dt className="text-xs text-muted-foreground">Sale amount</dt>
              <dd className="font-medium">
                <Amount
                  kind="currency"
                  value={event.amountMinor}
                  format={programCurrencyFormat(event.program, event.currencyCode)}
                />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Rewards affected</dt>
              <dd className="font-medium">
                {event.rewardCount > 0 ? (
                  <>
                    {pluralize(event.rewardCount, 'reward')} ·{' '}
                    <Amount
                      value={event.rewardTotalMinor}
                      format={programRewardFormat(event.program)}
                    />
                  </>
                ) : (
                  'None'
                )}
              </dd>
            </div>
          </dl>
          <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
            <li>Rewards still pending approval or approved are rejected.</li>
            <li>Posted rewards are reversed with a compensating ledger entry.</li>
            <li>
              Partial refunds are not supported. To correct the amount, reverse the sale and
              re-record it with the corrected details.
            </li>
          </ul>
        </div>
      </ConfirmDialog>
    </>
  );
}
