'use client';

import { ShieldAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { financeReasonSchema, type AdminRewardRowDto, type SaleComplianceDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { ConfirmDialog } from '@/components/app/confirm-dialog';
import { StatusBadge } from '@/components/app/status-badge';

import { currencyFormat, unitFormat } from '../../../finance/lib';
import { useApproveReward, useRejectReward, useReverseEvent, useReverseReward } from '../../api';

export type RewardDecisionKind = 'approve' | 'reject' | 'reverse' | 'reverse-event';

/** One user intent: the reward, what to do, and the Idempotency-Key created when it started. */
export interface RewardDecisionIntent {
  kind: RewardDecisionKind;
  reward: Pick<AdminRewardRowDto, 'id' | 'status' | 'level' | 'amountMinor' | 'rewardUnit' | 'currencyCode' | 'currencyMinorUnits' | 'recipient' | 'program' | 'event'> & {
    /** Present when the decision starts from the reward detail (full plan-payment review). */
    compliance?: SaleComplianceDto;
  };
  idempotencyKey: string;
}

const COPY: Record<
  RewardDecisionKind,
  { title: string; description: string; confirm: string; destructive: boolean; reason: boolean; typed?: string; success: string }
> = {
  approve: {
    title: 'Approve and post this reward?',
    description: 'The reward is approved and recorded in the ledger in one step (platform expense debited, member payable credited).',
    confirm: 'Approve and post',
    destructive: false,
    reason: false,
    success: 'Reward approved and posted',
  },
  reject: {
    title: 'Reject this reward?',
    description: 'The member sees the reason. Rejected rewards never count towards earnings and cannot be approved later.',
    confirm: 'Reject reward',
    destructive: true,
    reason: true,
    success: 'Reward rejected',
  },
  reverse: {
    title: 'Reverse this posted reward?',
    description: 'A compensating ledger transaction mirrors the posting and the reward is removed from the member’s earnings. This cannot be undone.',
    confirm: 'Reverse reward',
    destructive: true,
    reason: true,
    typed: 'REVERSE',
    success: 'Reward reversed',
  },
  'reverse-event': {
    title: 'Reverse the whole sale?',
    description:
      'Use this for a refund or chargeback. Every reward of the sale is rejected (if not yet posted) or reversed in the ledger, in one transaction. This cannot be undone.',
    confirm: 'Reverse sale',
    destructive: true,
    reason: true,
    typed: 'REVERSE',
    success: 'Sale reversed',
  },
};

export interface RewardDecisionDialogProps {
  intent: RewardDecisionIntent | null;
  onClose: () => void;
  /** Called after a successful decision. */
  onDone?: (kind: RewardDecisionKind) => void;
}

/** Confirmation dialog for approve / reject / reverse / reverse sale (reasons required where audited). */
export function RewardDecisionDialog({ intent, onClose, onDone }: RewardDecisionDialogProps) {
  const approve = useApproveReward();
  const reject = useRejectReward();
  const reverse = useReverseReward();
  const reverseEvent = useReverseEvent();
  // Keep showing the last intent while the dialog animates closed.
  const [shown, setShown] = useState(intent);
  if (intent && intent !== shown) setShown(intent);
  const copy = shown ? COPY[shown.kind] : COPY.approve;

  async function confirm(reason: string | undefined) {
    if (!intent) return;
    const { reward, idempotencyKey } = intent;
    switch (intent.kind) {
      case 'approve':
        await approve.mutateAsync({ id: reward.id, idempotencyKey });
        break;
      case 'reject':
        await reject.mutateAsync({ id: reward.id, reason: reason ?? '', idempotencyKey });
        break;
      case 'reverse':
        await reverse.mutateAsync({ id: reward.id, reason: reason ?? '', idempotencyKey });
        break;
      case 'reverse-event': {
        const res = await reverseEvent.mutateAsync({ eventId: reward.event.id, reason: reason ?? '', idempotencyKey });
        toast.success(copy.success, {
          description: `${res.reversedRewardIds.length} reversed, ${res.rejectedRewardIds.length} rejected.`,
        });
        onDone?.(intent.kind);
        return;
      }
    }
    toast.success(copy.success);
    onDone?.(intent.kind);
  }

  return (
    <ConfirmDialog
      open={intent !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={copy.title}
      description={copy.description}
      confirmLabel={copy.confirm}
      variant={copy.destructive ? 'destructive' : 'default'}
      reason={
        copy.reason
          ? {
              label: 'Reason',
              placeholder:
                shown?.kind === 'reject'
                  ? 'e.g. The sale could not be matched to an invoice.'
                  : 'e.g. Full refund issued to the customer on 12 Oct (ticket #4821).',
              description: 'At least 10 characters. Recorded in the audit log and shown to the affected member.',
              // Same limit as the API (`financeReasonSchema`: 10–480 characters).
              schema: financeReasonSchema,
              maxLength: 480,
            }
          : undefined
      }
      typedConfirmation={copy.typed}
      onConfirm={({ reason }) => confirm(reason)}
    >
      {shown ? (
        <div className="space-y-3">
          {shown.kind === 'approve' && shown.reward.event.planPaymentLookalike ? (
            <div role="alert" className="flex gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              <div className="space-y-1">
                <p className="font-medium">Compliance review: this sale looks like a plan payment</p>
                <p className="text-foreground/80">
                  {shown.reward.compliance?.message ??
                    'It has the same amount as a plan payment by the credited member or their downline. Plan payments never earn rewards: open the reward details and confirm it is a real sale to an end customer before approving.'}
                </p>
              </div>
            </div>
          ) : null}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border bg-muted/30 p-3">
            {shown.kind === 'reverse-event' ? (
              <>
                <Summary label="Sale">{shown.reward.event.externalId}</Summary>
                <Summary label="Sale amount">
                  <Amount
                    kind="currency"
                    value={shown.reward.event.amountMinor}
                    format={currencyFormat(shown.reward.event.currencyCode, shown.reward.currencyMinorUnits)}
                  />
                </Summary>
                <Summary label="Program">{shown.reward.program.name}</Summary>
                <Summary label="Credited member">{shown.reward.event.subject.fullName}</Summary>
              </>
            ) : (
              <>
                <Summary label="Recipient">{shown.reward.recipient.fullName}</Summary>
                <Summary label="Amount">
                  <Amount value={shown.reward.amountMinor} format={unitFormat(shown.reward)} className="font-medium" />
                </Summary>
                <Summary label="Program">
                  {shown.reward.program.name} · L{shown.reward.level}
                </Summary>
                <Summary label="Status">
                  <StatusBadge kind="RewardStatus" value={shown.reward.status} />
                </Summary>
              </>
            )}
          </dl>
        </div>
      ) : null}
    </ConfirmDialog>
  );
}

function Summary({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm">{children}</dd>
    </div>
  );
}
