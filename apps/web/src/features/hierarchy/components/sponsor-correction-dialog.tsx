'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, CheckCircle2, Shuffle } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import {
  reasonSchema,
  type SponsorCorrectionPreviewResponse,
  type SponsorCorrectionResponse,
} from '@app/shared';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { api, createIdempotencyKey, getErrorMessage } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';

import { hierarchyKeys } from '../query-keys';
import { MemberPicker, type PickedMember } from './member-picker';

export interface SponsorCorrectionDialogProps {
  memberId: string;
  memberName: string;
  onCorrected?: (result: SponsorCorrectionResponse) => void;
}

/**
 * Audited sponsor correction (SUPER_ADMIN, `referrals:correct`): pick the new sponsor (search or ID),
 * review the server preview (affected members, blocking rules), give a reason, confirm. The server
 * re-validates everything under the exclusive tree lock.
 */
export function SponsorCorrectionDialog({ memberId, memberName, onCorrected }: SponsorCorrectionDialogProps) {
  const [open, setOpen] = useState(false);
  const [newSponsor, setNewSponsor] = useState<PickedMember | null>(null);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(createIdempotencyKey);
  const queryClient = useQueryClient();
  const sponsorId = useId();
  const reasonId = useId();

  const newSponsorId = newSponsor?.id ?? '';
  const validId = newSponsor !== null;
  const preview = useQuery({
    queryKey: hierarchyKeys.correctionPreview(memberId, newSponsorId.toLowerCase()),
    queryFn: ({ signal }) =>
      api.get<SponsorCorrectionPreviewResponse>(`/admin/members/${memberId}/sponsor-correction/preview`, {
        query: { newSponsorId },
        signal,
      }),
    enabled: open && validId,
    staleTime: 0,
  });

  const reasonCheck = reasonSchema.safeParse(reason);
  const reasonError = reasonCheck.success ? null : (reasonCheck.error.issues[0]?.message ?? 'Give a reason');

  const mutation = useMutation({
    mutationFn: () =>
      api.post<SponsorCorrectionResponse>(
        `/admin/members/${memberId}/sponsor-correction`,
        { newSponsorId, reason: reason.trim() },
        { idempotencyKey },
      ),
    onSuccess: async (result) => {
      toast.success('Sponsor corrected', {
        description: `${result.affectedMembers} member${result.affectedMembers === 1 ? '' : 's'} moved. Past rewards are unchanged.`,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.admin.all });
      onCorrected?.(result);
      reset(false);
    },
  });

  function reset(nextOpen: boolean) {
    setOpen(nextOpen);
    setNewSponsor(null);
    setReason('');
    setTouched(false);
    setIdempotencyKey(createIdempotencyKey());
    mutation.reset();
  }

  const canSubmit = validId && preview.data?.canApply === true && !reasonError && !mutation.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (mutation.isPending) return;
        if (next) setOpen(true);
        else reset(false);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <Shuffle aria-hidden />
          Correct sponsor
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form
          className="contents"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (canSubmit) mutation.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Correct sponsor of {memberName}</DialogTitle>
            <DialogDescription>
              Moves this member and their whole team under another sponsor. Only future reward
              calculations use the new placement; past rewards never change. The change is audited.
            </DialogDescription>
          </DialogHeader>

          <Field data-invalid={touched && !validId ? true : undefined}>
            <FieldLabel htmlFor={sponsorId}>New sponsor</FieldLabel>
            <MemberPicker
              id={sponsorId}
              value={newSponsor}
              onChange={setNewSponsor}
              status="ACTIVE"
              excludeIds={[memberId]}
              invalid={touched && !validId}
              describedBy={`${sponsorId}-desc`}
              disabled={mutation.isPending}
            />
            <FieldDescription id={`${sponsorId}-desc`}>Active members only. You can also paste a member ID.</FieldDescription>
            {touched && !validId ? <FieldError>Choose the new sponsor.</FieldError> : null}
          </Field>

          {validId ? <PreviewBlock preview={preview.data} loading={preview.isFetching && !preview.data} error={preview.error} /> : null}

          <Field data-invalid={touched && reasonError ? true : undefined}>
            <FieldLabel htmlFor={reasonId}>
              Reason
              <span aria-hidden className="text-destructive">
                *
              </span>
            </FieldLabel>
            <Textarea
              id={reasonId}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onBlur={() => setTouched(true)}
              rows={3}
              maxLength={1000}
              placeholder="E.g. support ticket and what was verified — recorded in the audit log."
              aria-invalid={touched && reasonError ? true : undefined}
              disabled={mutation.isPending}
            />
            <FieldDescription>At least 10 characters.</FieldDescription>
            {touched && reasonError ? <FieldError>{reasonError}</FieldError> : null}
          </Field>

          {mutation.error ? (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {getErrorMessage(mutation.error)}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => reset(false)} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {mutation.isPending ? <Spinner aria-hidden /> : null}
              Move member
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PreviewBlock({
  preview,
  loading,
  error,
}: {
  preview: SponsorCorrectionPreviewResponse | undefined;
  loading: boolean;
  error: unknown;
}) {
  if (loading) return <Skeleton className="h-24 w-full" />;
  if (error) {
    return (
      <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {getErrorMessage(error)}
      </p>
    );
  }
  if (!preview) return null;
  return (
    <div className="space-y-3 rounded-lg bg-muted/50 p-3 text-sm" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">{preview.currentSponsor?.fullName ?? 'No sponsor'}</span>
        <ArrowRight className="size-4 text-muted-foreground" aria-label="moves to" />
        <span className="font-medium">{preview.newSponsor.fullName}</span>
      </div>
      <p className="text-muted-foreground">
        <span className="font-medium text-foreground tabular-nums">{preview.affectedMembers}</span> member
        {preview.affectedMembers === 1 ? '' : 's'} will move (this member and their team). New level from the
        top of the tree: <span className="tabular-nums">{preview.newDepthFromRoot}</span>.
      </p>
      {preview.issues.length > 0 ? (
        <ul className="space-y-1.5">
          {preview.issues.map((issue) => (
            <li key={issue.code} className="flex items-start gap-2 text-destructive">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              {issue.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="flex items-center gap-2 text-success">
          <CheckCircle2 className="size-4" aria-hidden />
          All checks passed. The server re-checks when you confirm.
        </p>
      )}
    </div>
  );
}
