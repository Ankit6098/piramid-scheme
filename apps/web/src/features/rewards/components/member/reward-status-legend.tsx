import { StatusBadge } from '@/components/app/status-badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const ITEMS = [
  { status: 'PENDING_APPROVAL', text: 'Calculated from a qualifying sale and waiting for a reviewer. Counted as pending, not yet earned.' },
  { status: 'POSTED', text: 'Approved and recorded in the ledger. Counted in “Earned to date”.' },
  { status: 'REJECTED', text: 'Not approved (for example, the sale could not be verified or was refunded before approval). Never counted.' },
  { status: 'REVERSED', text: 'Posted earlier, then reversed with a compensating ledger entry (for example, after a refund). Removed from “Earned to date”.' },
] as const;

/** Plain-language explanation of the reward statuses a member can see. */
export function RewardStatusLegend() {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>What the statuses mean</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-3 sm:grid-cols-2">
          {ITEMS.map((item) => (
            <div key={item.status} className="space-y-1">
              <dt>
                <StatusBadge kind="RewardStatus" value={item.status} />
              </dt>
              <dd className="text-xs text-muted-foreground">{item.text}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
