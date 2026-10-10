'use client';

import { Ban, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import type { AdminMemberDetailDto } from '@app/shared';

import { ConfirmDialog } from '@/components/app/confirm-dialog';
import { Button } from '@/components/ui/button';

import { useChangeMemberStatus } from '../api';

/** Suspend (revokes all sessions) or reactivate, with an audited reason. Hidden when not allowed. */
export function MemberStatusAction({ member }: { member: AdminMemberDetailDto }) {
  const mutation = useChangeMemberStatus(member.id);

  if (member.can.suspend) {
    return (
      <ConfirmDialog
        trigger={
          <Button variant="destructive" size="sm">
            <Ban aria-hidden />
            Suspend
          </Button>
        }
        title={`Suspend ${member.fullName}?`}
        description="They are signed out of every session immediately and cannot sign in until an administrator reactivates the account. Their data, team and recorded rewards stay unchanged."
        variant="destructive"
        confirmLabel="Suspend member"
        reason={{ label: 'Reason for suspension' }}
        onConfirm={async ({ reason }) => {
          const result = await mutation.mutateAsync({ action: 'suspend', reason: reason ?? '' });
          toast.success(`${member.fullName} was suspended`, {
            description:
              result.sessionsRevoked > 0
                ? `${result.sessionsRevoked} active session${result.sessionsRevoked === 1 ? '' : 's'} ended.`
                : undefined,
          });
        }}
      />
    );
  }

  if (member.can.reactivate) {
    return (
      <ConfirmDialog
        trigger={
          <Button variant="outline" size="sm">
            <RotateCcw aria-hidden />
            Reactivate
          </Button>
        }
        title={`Reactivate ${member.fullName}?`}
        description="The member can sign in again and is notified that the account was reactivated."
        confirmLabel="Reactivate member"
        reason={{ label: 'Reason for reactivation' }}
        onConfirm={async ({ reason }) => {
          await mutation.mutateAsync({ action: 'reactivate', reason: reason ?? '' });
          toast.success(`${member.fullName} was reactivated`);
        }}
      >
        {member.suspensionReason ? (
          <p className="rounded-lg bg-muted px-3 py-2 text-muted-foreground">
            Suspended because: <span className="text-foreground">{member.suspensionReason}</span>
          </p>
        ) : null}
      </ConfirmDialog>
    );
  }

  return null;
}
