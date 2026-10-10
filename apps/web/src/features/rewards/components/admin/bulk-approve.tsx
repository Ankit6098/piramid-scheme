'use client';

import { CheckCheck, CircleAlert, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { MAX_BULK_APPROVE, type AdminRewardRowDto, type BulkApproveResultDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { ConfirmDialog } from '@/components/app/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { createIdempotencyKey } from '@/lib/api-client';

import { unitFormat } from '../../../finance/lib';
import { useBulkApproveRewards } from '../../api';

export interface BulkApproveBarProps {
  selected: AdminRewardRowDto[];
  onClear: () => void;
  /** Called with the ids that were approved. */
  onDone: (approvedIds: string[]) => void;
}

/** Sticky action bar for the selected rewards: approve them all (one transaction each). */
export function BulkApproveBar({ selected, onClear, onDone }: BulkApproveBarProps) {
  const [open, setOpen] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(createIdempotencyKey);
  const [result, setResult] = useState<BulkApproveResultDto | null>(null);
  const [resultNames, setResultNames] = useState<ReadonlyMap<string, string>>(new Map());
  const bulk = useBulkApproveRewards();
  const tooMany = selected.length > MAX_BULK_APPROVE;

  // A single total is only meaningful when every selected reward uses the same unit + currency.
  const first = selected[0];
  const sameUnit = first && selected.every((r) => r.rewardUnit === first.rewardUnit && r.currencyCode === first.currencyCode);
  const total = sameUnit ? selected.reduce((sum, r) => sum + BigInt(r.amountMinor), BigInt(0)).toString() : null;

  if (selected.length === 0 && !result) return null;

  return (
    <>
      {selected.length > 0 ? (
        <div
          role="region"
          aria-label="Bulk actions"
          className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-popover px-4 py-3 shadow-lg"
        >
          <p className="text-sm">
            <span className="font-medium">{selected.length} selected</span>
            {total && first ? (
              <span className="text-muted-foreground">
                {' '}
                · <Amount value={total} format={unitFormat(first)} />
              </span>
            ) : null}
            {tooMany ? <span className="text-destructive"> · at most {MAX_BULK_APPROVE} at a time</span> : null}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClear}>
              <X aria-hidden />
              Clear
            </Button>
            <Button
              size="sm"
              disabled={tooMany}
              onClick={() => {
                setIdempotencyKey(createIdempotencyKey());
                setOpen(true);
              }}
            >
              <CheckCheck aria-hidden />
              Approve selected
            </Button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Approve and post ${selected.length} ${selected.length === 1 ? 'reward' : 'rewards'}?`}
        description="Each reward is approved and posted to the ledger in its own transaction. Rewards that cannot be approved (already decided, sale reversed, or conflicting with segregation of duties) are skipped and listed afterwards."
        confirmLabel="Approve all"
        onConfirm={async () => {
          setResultNames(new Map(selected.map((r) => [r.id, `${r.recipient.fullName} · L${r.level}`])));
          const res = await bulk.mutateAsync({ ids: selected.map((r) => r.id), idempotencyKey });
          onDone(res.results.filter((r) => r.ok).map((r) => r.id));
          if (res.failed === 0) {
            toast.success(`${res.approved} ${res.approved === 1 ? 'reward' : 'rewards'} approved and posted`);
          } else {
            setResult(res);
          }
        }}
      >
        {total && first ? (
          <p className="rounded-lg border bg-muted/30 px-3 py-2">
            Total: <Amount value={total} format={unitFormat(first)} className="font-medium" />
          </p>
        ) : null}
      </ConfirmDialog>

      <Dialog open={result !== null} onOpenChange={(o) => (o ? null : setResult(null))}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {result ? `${result.approved} approved, ${result.failed} not approved` : 'Bulk approval'}
            </DialogTitle>
            <DialogDescription>The rewards below were left unchanged.</DialogDescription>
          </DialogHeader>
          <ul className="max-h-72 space-y-2 overflow-y-auto">
            {result?.results
              .filter((r) => !r.ok)
              .map((r) => (
                <li key={r.id} className="flex gap-2 rounded-lg border px-3 py-2">
                  <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
                  <div className="min-w-0 text-sm">
                    <p className="font-medium">{resultNames.get(r.id) ?? r.id}</p>
                    <p className="text-muted-foreground">{r.ok ? '' : r.error.message}</p>
                  </div>
                </li>
              ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResult(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
