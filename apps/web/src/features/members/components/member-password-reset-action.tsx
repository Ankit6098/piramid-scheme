'use client';

import { KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import { isAdminRole, type AdminMemberDetailDto } from '@app/shared';

import { ConfirmDialog } from '@/components/app/confirm-dialog';
import { Button } from '@/components/ui/button';

import { useSendMemberPasswordReset } from '../api';

/**
 * Super Admin action: email the member a password reset code (with an audited reason). The member is
 * signed out everywhere and chooses the new password on the normal reset page — this is how admin-role
 * accounts, whose self-service reset is disabled, get back in. Hidden unless the API allows it.
 */
export function MemberPasswordResetAction({ member }: { member: AdminMemberDetailDto }) {
  const mutation = useSendMemberPasswordReset(member.id);
  if (!member.can.sendPasswordReset) return null;

  const adminAccount = member.roles.some((r) => isAdminRole(r.role));

  return (
    <ConfirmDialog
      trigger={
        <Button variant="outline" size="sm">
          <KeyRound aria-hidden />
          Send password reset
        </Button>
      }
      title={`Send a password reset to ${member.fullName}?`}
      description={
        adminAccount
          ? 'Administrators cannot reset their own password, so a Super Admin sends the code. They are signed out of every session now and set a new password with the emailed code (valid for 10 minutes). All Super Admins are notified.'
          : 'They are signed out of every session now and set a new password with the emailed code (valid for 10 minutes). All Super Admins are notified.'
      }
      confirmLabel="Send reset code"
      reason={{
        label: 'Reason for the reset',
        placeholder: 'e.g. Owner lost access to their password — confirmed by phone.',
      }}
      onConfirm={async ({ reason }) => {
        const result = await mutation.mutateAsync({ reason: reason ?? '' });
        toast.success(`Reset code sent to ${result.sentTo}`, {
          description:
            result.sessionsRevoked > 0
              ? `${result.sessionsRevoked} active session${result.sessionsRevoked === 1 ? '' : 's'} ended.`
              : 'The account had no active sessions.',
        });
      }}
    >
      <p className="rounded-lg bg-muted px-3 py-2 text-muted-foreground">
        The code goes to <span className="text-foreground">{member.email}</span>. Their current
        password stays valid until they set a new one. Verify the request with the account owner
        before sending.
      </p>
    </ConfirmDialog>
  );
}
