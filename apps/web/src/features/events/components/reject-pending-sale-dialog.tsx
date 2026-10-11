'use client';

import { Ban } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { financeReasonSchema, type SaleEventDetailDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { ConfirmDialog } from '@/components/app/confirm-dialog';
import { DateTime } from '@/components/app/date-time';
import { Button } from '@/components/ui/button';
import { createIdempotencyKey } from '@/lib/api-client';

import { useRejectPendingSale } from '../api';
import { programCurrencyFormat } from '../labels';

/**
 * Rejects a sale stuck in RECEIVED (`events:reverse`): it never earned anything, and once rejected
 * the same external id can be re-recorded with corrected details as a new revision.
 */
export function RejectPendingSaleDialog({ event }: { event: SaleEventDetailDto }) {
  const [open, setOpen] = useState(false);
  // One Idempotency-Key per dialog open: a retry after a network error reuses it.
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const reject = useRejectPendingSale();

  function handleOpenChange(next: boolean) {
    if (next) setIdempotencyKey(createIdempotencyKey());
    setOpen(next);
  }

  return (
    <>
      <Button variant="outline" onClick={() => handleOpenChange(true)}>
        <Ban aria-hidden />
        Reject stuck sale
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={handleOpenChange}
        variant="destructive"
        title={`Reject sale ${event.externalId}?`}
        description="Use this only for a sale that is stuck waiting for processing. It is stored as rejected (no rewards) and can then be re-recorded with corrected details."
        reason={{
          label: 'Reason',
          placeholder: 'e.g. Stuck in processing: the amount was entered in the wrong unit.',
          description: 'At least 10 characters. Recorded in the audit log and on the sale.',
          // Same limit as the API (`financeReasonSchema`: 10–480 characters).
          schema: financeReasonSchema,
          maxLength: 480,
        }}
        confirmLabel="Reject sale"
        onConfirm={async ({ reason }) => {
          await reject.mutateAsync({
            eventId: event.id,
            reason: reason ?? '',
            idempotencyKey: idempotencyKey ?? createIdempotencyKey(),
          });
          toast.success('Sale rejected', { description: 'You can now re-record it with corrected details.' });
        }}
      >
        <dl className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/30 p-3">
          <div>
            <dt className="text-xs text-muted-foreground">Sale amount</dt>
            <dd className="font-medium">
              <Amount kind="currency" value={event.amountMinor} format={programCurrencyFormat(event.program, event.currencyCode)} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Waiting since</dt>
            <dd className="font-medium">
              <DateTime value={event.createdAt} timeZone={event.program.timezone} />
            </dd>
          </div>
        </dl>
      </ConfirmDialog>
    </>
  );
}
