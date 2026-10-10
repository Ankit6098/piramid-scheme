'use client';

import { Ban } from 'lucide-react';
import { toast } from 'sonner';
import type { ApiClientDto } from '@app/shared';

import { ConfirmDialog } from '@/components/app/confirm-dialog';
import { RelativeTime } from '@/components/app/date-time';
import { Button } from '@/components/ui/button';

import { useRevokeApiClient } from '../api';

/** Row action: permanently disables an API key (ConfirmDialog, optional reason). */
export function RevokeApiClientButton({ client }: { client: ApiClientDto }) {
  const revoke = useRevokeApiClient();
  return (
    <ConfirmDialog
      trigger={
        <Button variant="destructive" size="sm" aria-label={`Revoke API client ${client.name}`}>
          <Ban aria-hidden />
          Revoke
        </Button>
      }
      variant="destructive"
      title={`Revoke “${client.name}”?`}
      description="The key stops working immediately and every request that uses it is refused. This can't be undone — create a new client to restore access."
      reason={{
        required: false,
        label: 'Reason (optional)',
        placeholder: 'e.g. Key exposed in a support ticket.',
        description: 'If you give one, at least 10 characters. Recorded in the audit log.',
      }}
      confirmLabel="Revoke key"
      onConfirm={async ({ reason }) => {
        await revoke.mutateAsync({ id: client.id, input: reason ? { reason } : {} });
        toast.success(`Revoked ${client.name}`, {
          description: 'The key can no longer submit sales.',
        });
      }}
    >
      <dl className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/30 p-3">
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">Program</dt>
          <dd className="truncate">{client.program.name}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Key</dt>
          <dd className="font-mono text-xs">{client.keyPrefix}…</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-xs text-muted-foreground">Last used</dt>
          <dd>
            {client.lastUsedAt ? <RelativeTime value={client.lastUsedAt} /> : 'Never'}
          </dd>
        </div>
      </dl>
    </ConfirmDialog>
  );
}
