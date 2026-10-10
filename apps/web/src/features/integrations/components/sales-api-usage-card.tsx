import { API_KEY_PREFIX } from '@app/shared';

import { CopyButton } from '@/components/app/copy-button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const ENDPOINT = '/api/v1/integrations/events';

const EXAMPLE_BODY = `{
  "type": "PRODUCT_SALE",
  "externalId": "INV-2026-000123",
  "customerReference": "CUST-88412",
  "subjectUserId": "8b6f0f5e-2a4b-4c1d-9e3f-1a2b3c4d5e6f",
  "amountMinor": "149900",
  "occurredAt": "2026-10-10T09:30:00+05:30",
  "description": "Annual plan, retail customer"
}`;

const EXAMPLE_REQUEST = `POST ${ENDPOINT}
Authorization: Bearer ${API_KEY_PREFIX}…
Content-Type: application/json

${EXAMPLE_BODY}`;

/** Usage hint for the machine endpoint (no cookies/CSRF — bearer key only). */
export function SalesApiUsageCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="font-heading text-base font-semibold tracking-tight">How to send sales</h2>
        </CardTitle>
        <CardDescription>
          Your sales system submits each qualifying sale with the client&apos;s key. The key decides
          the program, so <code className="font-mono text-xs">programId</code> is optional.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Example request</p>
            <CopyButton value={EXAMPLE_BODY} label="example body" size="sm" variant="ghost">
              Copy body
            </CopyButton>
          </div>
          <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed">
            {EXAMPLE_REQUEST}
          </pre>
        </div>
        <ul className="list-disc space-y-2 pl-4 text-sm text-muted-foreground marker:text-muted-foreground/60">
          <li>
            <code className="font-mono text-xs text-foreground">amountMinor</code> is a string of
            minor units in the program currency (&quot;149900&quot; = 1,499.00 with two decimals).
            Never send decimals or floats.
          </li>
          <li>
            <code className="font-mono text-xs text-foreground">occurredAt</code> is an ISO 8601
            timestamp with a time-zone offset; it must fall within the program period and not in the
            future.
          </li>
          <li>
            <code className="font-mono text-xs text-foreground">subjectUserId</code> is the member
            credited with the sale; rewards go to their eligible upline.
          </li>
          <li>
            Resubmitting the same sale is safe: an identical request returns the existing record
            (<code className="font-mono text-xs text-foreground">replayed: true</code>).
          </li>
          <li>
            Different details for an existing{' '}
            <code className="font-mono text-xs text-foreground">externalId</code> are refused with{' '}
            <code className="font-mono text-xs text-foreground">409 IDEMPOTENCY_CONFLICT</code>. A
            corrected version of a rejected or reversed sale is stored as a new revision.
          </li>
          <li>
            Sales that fail a business rule are stored as{' '}
            <code className="font-mono text-xs text-foreground">REJECTED</code> with a{' '}
            <code className="font-mono text-xs text-foreground">rejectionReason</code> — check{' '}
            <code className="font-mono text-xs text-foreground">status</code> in the response.
          </li>
          <li>
            Send only sales of the program&apos;s approved offering to end customers — never a
            member&apos;s own plan payment.
          </li>
        </ul>
      </CardContent>
    </Card>
  );
}
