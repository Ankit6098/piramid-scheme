'use client';

import { Archive, Copy } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Permission, type PolicyVersionDto, type PolicyVersionSummaryDto } from '@app/shared';

import { ConfirmDialog } from '@/components/app/confirm-dialog';
import { DateTime } from '@/components/app/date-time';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useSession } from '@/hooks/use-session';
import { createIdempotencyKey, getErrorMessage, isApiError } from '@/lib/api-client';

import { useCreatePolicyDraft, useRetirePolicy } from '../api';

export interface PolicyVersionActionsProps {
  policy: PolicyVersionDto;
  /** All loaded versions (to explain what retiring changes on the timeline). */
  versions: readonly PolicyVersionSummaryDto[];
  onCloned: (draft: PolicyVersionDto) => void;
}

/** Actions for published / retired versions: clone to a new draft and retire (or withdraw). */
export function PolicyVersionActions({ policy, versions, onCloned }: PolicyVersionActionsProps) {
  const { can } = useSession();
  const create = useCreatePolicyDraft(policy.programId);
  const retire = useRetirePolicy(policy.id);
  const [retireOpen, setRetireOpen] = useState(false);
  const [retireKey, setRetireKey] = useState<string | null>(null);

  const canWrite = can(Permission.PoliciesWrite);
  const canRetire =
    can(Permission.PoliciesPublish) && (policy.phase === 'CURRENT' || policy.phase === 'SCHEDULED');
  const scheduled = policy.phase === 'SCHEDULED';
  const tz = policy.program.timezone;

  // Context for the explanation: the version this one closed (it keeps that end time when this one
  // is withdrawn) and the next scheduled version (sales before it start find no policy).
  const predecessor = scheduled
    ? versions.find(
        (v) => v.id !== policy.id && v.effectiveTo && v.effectiveTo === policy.effectiveFrom,
      )
    : undefined;
  const successor = !scheduled
    ? versions
        .filter((v) => v.id !== policy.id && v.phase === 'SCHEDULED' && v.effectiveFrom)
        .sort((a, b) => (a.effectiveFrom ?? '').localeCompare(b.effectiveFrom ?? ''))[0]
    : undefined;

  async function clone() {
    try {
      const draft = await create.mutateAsync({ cloneFromVersionId: policy.id });
      toast.success(`Draft version ${draft.version} created`, {
        description: `Copied from version ${policy.version}. Edit it, then publish to replace this version.`,
      });
      onCloned(draft);
    } catch (error) {
      toast.error("Couldn't create the draft", { description: getErrorMessage(error) });
    }
  }

  function openRetire() {
    setRetireKey(createIdempotencyKey());
    setRetireOpen(true);
  }

  async function confirmRetire({ reason }: { reason?: string }) {
    try {
      const result = await retire.mutateAsync({
        reason: reason ?? '',
        idempotencyKey: retireKey ?? undefined,
      });
      toast.success(
        result.withdrawn
          ? `Version ${policy.version} withdrawn`
          : `Version ${policy.version} retired`,
      );
      for (const warning of result.warnings) toast.warning(warning);
    } catch (error) {
      // A definitive rejection means a new attempt is a new intent (the reason may change).
      if (isApiError(error) && error.status >= 400 && error.status < 500) {
        setRetireKey(createIdempotencyKey());
      }
      throw error;
    }
  }

  if (!canWrite && !canRetire) return null;

  return (
    <>
      {canWrite ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => void clone()}
          disabled={create.isPending}
        >
          {create.isPending ? <Spinner aria-hidden /> : <Copy aria-hidden />}
          Clone to new draft
        </Button>
      ) : null}
      {canRetire ? (
        <Button type="button" variant="destructive" onClick={openRetire}>
          <Archive aria-hidden />
          Retire
        </Button>
      ) : null}

      <ConfirmDialog
        open={retireOpen}
        onOpenChange={setRetireOpen}
        variant="destructive"
        title={
          scheduled ? `Withdraw version ${policy.version}?` : `Retire version ${policy.version}?`
        }
        description={
          scheduled
            ? 'This version has not taken effect yet. Retiring it withdraws it: it will never apply to any sale.'
            : 'This version stops applying to new sales immediately — its effective range ends now. Rewards already calculated with it are not changed.'
        }
        confirmLabel={scheduled ? 'Withdraw version' : 'Retire version'}
        reason={{
          label: 'Reason',
          description: 'At least 10 characters. Recorded in the audit log.',
        }}
        onConfirm={confirmRetire}
      >
        <div className="space-y-2 rounded-lg bg-muted/60 p-3 text-sm">
          {scheduled ? (
            predecessor ? (
              <p>
                Version {predecessor.version} was set to end when this one starts (
                <DateTime value={predecessor.effectiveTo} timeZone={tz} showTimeZone />
                ). It keeps that end time, so from then on <strong>
                  no policy is in effect
                </strong>{' '}
                and new sales are rejected until another version is published.
              </p>
            ) : (
              <p>
                Withdrawing can leave a gap with <strong>no policy in effect</strong>; sales during
                a gap are rejected until another version is published.
              </p>
            )
          ) : successor ? (
            <p>
              Version {successor.version} is scheduled to start on{' '}
              <DateTime value={successor.effectiveFrom} timeZone={tz} showTimeZone />. Until then,{' '}
              <strong>no policy is in effect</strong> and new sales are rejected.
            </p>
          ) : (
            <p>
              No other version is scheduled. Afterwards <strong>no policy is in effect</strong> and
              new sales are rejected until another version is published.
            </p>
          )}
          <p className="text-muted-foreground">
            Sales already priced by this version: {policy.boundEventCount.toLocaleString('en')}
          </p>
        </div>
      </ConfirmDialog>
    </>
  );
}
