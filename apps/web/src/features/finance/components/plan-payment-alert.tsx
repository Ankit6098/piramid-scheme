'use client';

import { ShieldAlert } from 'lucide-react';
import type { PlanPaymentMatchDto, SaleComplianceDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { DateTime } from '@/components/app/date-time';
import { ToneBadge } from '@/components/app/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

import { currencyFormat } from '../lib';

function payerRelation(m: PlanPaymentMatchDto): string {
  if (m.relation === 'OWN') return 'the credited member';
  return m.depth === 1 ? 'a direct recruit of the credited member' : `${m.depth} levels below the credited member`;
}

/**
 * Compliance warning (business rules §0.1): the sale has the amount of a plan payment by the
 * credited member or by a member of their downline. Shown to reviewers before they approve the
 * sale's rewards (which are never approved automatically). Renders nothing for a clean sale.
 */
export function PlanPaymentAlert({
  compliance,
  minorUnits,
  timeZone,
  className,
}: {
  compliance: SaleComplianceDto;
  /** Minor units of the program currency (sale amounts). */
  minorUnits?: number;
  timeZone?: string;
  className?: string;
}) {
  if (!compliance.planPaymentLookalike) return null;
  return (
    <Alert className={cn('border-warning/30 bg-warning/10 text-foreground', className)}>
      <ShieldAlert className="text-warning" aria-hidden />
      <AlertTitle className="flex flex-wrap items-center gap-2">
        Compliance review: this sale looks like a plan payment
        {compliance.flag ? (
          <ToneBadge tone={compliance.flag.status === 'OPEN' ? 'warning' : 'muted'} dot={false}>
            Flag {compliance.flag.status.toLowerCase()}
          </ToneBadge>
        ) : null}
      </AlertTitle>
      <AlertDescription className="text-foreground/80">
        <p>
          {compliance.message ??
            'This sale resembles a plan payment. Plan payments never earn rewards: confirm it is a real sale to an end customer before approving.'}
        </p>
        {compliance.matches.length > 0 ? (
          <ul className="mt-2 list-disc space-y-1 pl-4">
            {compliance.matches.map((m) => (
              <li key={m.enrollmentId}>
                <span className="font-medium text-foreground">{m.payer.fullName}</span> ({payerRelation(m)}) paid{' '}
                <Amount kind="currency" value={m.amountMinor} format={currencyFormat(m.currencyCode, minorUnits)} /> for{' '}
                {m.program.name} on <DateTime value={m.paymentRecordedAt} timeZone={timeZone} />
              </li>
            ))}
          </ul>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/** Compact marker for table rows and confirmation dialogs. */
export function PlanPaymentBadge({ className }: { className?: string }) {
  return (
    <ToneBadge
      tone="warning"
      dot={false}
      className={className}
      title="Same amount as a plan payment by the credited member or their downline — review before approving"
    >
      <ShieldAlert className="size-3" aria-hidden />
      Plan payment?
    </ToneBadge>
  );
}
