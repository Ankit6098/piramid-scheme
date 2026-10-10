import { ShieldCheck } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

/** Fixed guardrails (business rules §0) shown above every policy — not configurable. */
export function PolicyComplianceCallout({
  hardCapLabel = '50%',
  className,
}: {
  hardCapLabel?: string;
  className?: string;
}) {
  return (
    <Alert role="note" className={cn('border-primary/20 bg-primary/5', className)}>
      <ShieldCheck aria-hidden className="text-primary" />
      <AlertTitle>How rewards are funded</AlertTitle>
      <AlertDescription>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          <li>
            Rewards are calculated only from qualifying sales of this program&apos;s approved
            offering — never from sign-ups, referrals or plan payments.
          </li>
          <li>
            Total rewards for a sale can never exceed {hardCapLabel} of the sale value. This hard
            cap is enforced by the database for every policy and every calculation.
          </li>
          <li>Real-money payouts are not enabled. Rewards are recorded in the ledger only.</li>
        </ul>
      </AlertDescription>
    </Alert>
  );
}
