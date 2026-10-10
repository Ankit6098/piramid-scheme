'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { CircleCheck, Rocket, ShieldAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { useController, useForm, useWatch, type Control } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  ErrorCode,
  formatBps,
  Permission,
  type PolicyContextDto,
  type PolicyIssueDto,
  type PolicyVersionDto,
  type PolicyVersionSummaryDto,
  type PublishPolicyResultDto,
} from '@app/shared';

import { Amount } from '@/components/app/amount';
import { DateTime } from '@/components/app/date-time';
import { FormDateTimeField } from '@/components/app/form';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { useNow } from '@/hooks/use-now';
import { useSession } from '@/hooks/use-session';
import { createIdempotencyKey, getErrorMessage, isApiError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/datetime';
import { enumLabel } from '@/lib/enum-labels';

import { usePolicyValidation, usePublishPolicy, useValidatePolicy } from '../api';
import { rewardFormat } from '../format';
import { issuesFromErrorDetails } from '../form';
import { useDebouncedValue } from '../hooks';
import { approvalModeLabel, issueFieldLabel } from '../labels';
import { FormRadioCards } from './fields';
import { PolicyIssueList } from './policy-issues';

const publishSchema = z
  .object({
    when: z.enum(['NOW', 'SCHEDULE']),
    effectiveFrom: z.string(),
    acknowledged: z.boolean().refine((value) => value, {
      message: 'Confirm that you understand published policies cannot be edited',
    }),
  })
  .superRefine((value, ctx) => {
    if (value.when !== 'SCHEDULE') return;
    if (!value.effectiveFrom) {
      ctx.addIssue({
        code: 'custom',
        path: ['effectiveFrom'],
        message: 'Choose when this version takes effect',
      });
    } else if (Date.parse(value.effectiveFrom) < Date.now() - 60_000) {
      ctx.addIssue({
        code: 'custom',
        path: ['effectiveFrom'],
        message: 'Policies cannot take effect in the past. Choose a future time or "Now".',
      });
    }
  });
type PublishValues = z.input<typeof publishSchema>;
type PublishOutput = z.output<typeof publishSchema>;

export interface PublishPolicyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  policy: PolicyVersionDto;
  context: PolicyContextDto;
  versions: readonly PolicyVersionSummaryDto[];
  /** `Date.now()` captured when the dialog was opened (defaults for "now" / "schedule"). */
  openedAt: number;
  onPublished: (result: PublishPolicyResultDto) => void;
}

/** Publish a saved draft now or at a scheduled time, after a final validation. */
export function PublishPolicyDialog({ open, onOpenChange, ...props }: PublishPolicyDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-xl">
        {open ? <PublishForm {...props} onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function defaultScheduleIso(openedAt: number): string {
  // Next full hour at least 30 minutes away.
  const hour = 3_600_000;
  return new Date(Math.ceil((openedAt + 30 * 60_000) / hour) * hour).toISOString();
}

function PublishForm({
  policy,
  context,
  versions,
  openedAt,
  onPublished,
  onClose,
}: Omit<PublishPolicyDialogProps, 'open' | 'onOpenChange'> & { onClose: () => void }) {
  const { can } = useSession();
  const program = policy.program;
  const tz = program.timezone;
  const rewardFmt = rewardFormat(program, context.pointsLabel);
  const validate = useValidatePolicy(policy.id);
  const publish = usePublishPolicy(policy.id);
  const [idempotencyKey, setIdempotencyKey] = useState(createIdempotencyKey);
  const [blockingIssues, setBlockingIssues] = useState<PolicyIssueDto[] | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<PublishValues, unknown, PublishOutput>({
    resolver: zodResolver(publishSchema),
    defaultValues: {
      when: 'NOW',
      effectiveFrom: defaultScheduleIso(openedAt),
      acknowledged: false,
    },
    mode: 'onChange',
  });
  const when = useWatch({ control: form.control, name: 'when' });
  const scheduledIso = useWatch({ control: form.control, name: 'effectiveFrom' });
  // "Now" is previewed with a clock that ticks every 30 s (the API allows 1 minute of skew); the
  // final check at submit uses the exact submit time.
  const now = useNow();
  const scheduledValid = Boolean(scheduledIso) && !Number.isNaN(Date.parse(scheduledIso));
  const previewIso =
    when === 'NOW' ? new Date(now ?? openedAt).toISOString() : scheduledValid ? scheduledIso : null;

  // A new start time is a new attempt: forget issues returned for the previous one.
  const target = when === 'NOW' ? 'NOW' : scheduledIso;
  const [issuesTarget, setIssuesTarget] = useState(target);
  if (issuesTarget !== target) {
    setIssuesTarget(target);
    setBlockingIssues(null);
  }

  // Live publish-time checks for the chosen start (debounced; each start is its own cache entry).
  const previewBody = useDebouncedValue(
    previewIso ? JSON.stringify({ effectiveFrom: previewIso }) : null,
    400,
  );
  const preview = usePolicyValidation(policy.id, policy.updatedAt, previewBody);
  const issues = blockingIssues ?? preview.data?.issues ?? [];
  const hasErrors = issues.some((issue) => issue.severity === 'error');

  const autoApproveBlocked = !policy.requiresApproval && !can(Permission.PoliciesAutoApprove);
  const startMs = previewIso ? Date.parse(previewIso) : openedAt;
  const current = versions.find((v) => v.id === context.currentVersionId && v.id !== policy.id);
  const nextScheduled = versions
    .filter(
      (v) =>
        v.id !== policy.id &&
        v.phase === 'SCHEDULED' &&
        v.effectiveFrom !== null &&
        Date.parse(v.effectiveFrom) > startMs,
    )
    .sort((a, b) => (a.effectiveFrom ?? '').localeCompare(b.effectiveFrom ?? ''))[0];
  const percentageLevels = policy.rules.filter((rule) => rule.calcType === 'PERCENTAGE').length;
  const fixedLevels = policy.rules.length - percentageLevels;

  const onSubmit = form.handleSubmit(async (values) => {
    setSubmitError(null);
    setBlockingIssues(null);
    setSubmitting(true);
    const effectiveFrom = values.when === 'NOW' ? new Date().toISOString() : values.effectiveFrom;
    try {
      const check = await validate.mutateAsync({ effectiveFrom });
      if (check.issues.some((issue) => issue.severity === 'error')) {
        setBlockingIssues(check.issues);
        return;
      }
      const result = await publish.mutateAsync({ effectiveFrom, idempotencyKey });
      const startsAt = result.policy.effectiveFrom ?? effectiveFrom;
      toast.success(
        values.when === 'SCHEDULE'
          ? `Version ${result.policy.version} scheduled`
          : `Version ${result.policy.version} published`,
        {
          description: [
            `In effect from ${formatDateTime(startsAt, { timeZone: tz })} (${tz}).`,
            result.closedVersion
              ? `Version ${result.closedVersion.version} ends at that time.`
              : null,
          ]
            .filter(Boolean)
            .join(' '),
        },
      );
      onClose();
      onPublished(result);
    } catch (error) {
      if (isApiError(error) && error.status >= 400 && error.status < 500) {
        setIdempotencyKey(createIdempotencyKey());
      }
      if (isApiError(error) && error.code === ErrorCode.PolicyInvalid) {
        const fromServer = issuesFromErrorDetails(error.details);
        setBlockingIssues(
          fromServer.length > 0
            ? fromServer
            : [{ severity: 'error', path: 'policy', message: error.message }],
        );
        return;
      }
      setSubmitError(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate className="grid gap-5">
      <DialogHeader>
        <DialogTitle>Publish version {policy.version}</DialogTitle>
        <DialogDescription>
          Published versions and their reward levels are permanent. To change them later, clone the
          version into a new draft.
        </DialogDescription>
      </DialogHeader>

      <section
        aria-label="Version summary"
        className="space-y-2 rounded-lg bg-muted/50 p-3 text-sm"
      >
        <p className="font-medium">{policy.name}</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">Budget</dt>
            <dd className="font-medium">{formatBps(policy.budgetBps)} of the sale</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Max total per sale</dt>
            <dd className="font-medium">
              <Amount value={policy.maxTotalPerEventMinor} format={rewardFmt} fallback="No limit" />
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Depth</dt>
            <dd className="font-medium">
              {policy.maxDepth} · {policy.rules.length}{' '}
              {policy.rules.length === 1 ? 'level' : 'levels'}
            </dd>
          </div>
          <div className="col-span-2 sm:col-span-3">
            <dt className="text-muted-foreground">Levels</dt>
            <dd className="font-medium">
              {[...policy.rules]
                .sort((a, b) => a.level - b.level)
                .map((rule) => (
                  <span key={rule.id} className="mr-3 inline-block whitespace-nowrap">
                    L{rule.level}:{' '}
                    {rule.calcType === 'PERCENTAGE' && rule.percentageBps !== null ? (
                      formatBps(rule.percentageBps)
                    ) : (
                      <Amount value={rule.fixedAmountMinor} format={rewardFmt} />
                    )}
                  </span>
                ))}
              {policy.rules.length === 0 ? '—' : null}
            </dd>
          </div>
          <div className="col-span-2 sm:col-span-3">
            <dt className="text-muted-foreground">Applies to</dt>
            <dd className="font-medium">
              {policy.triggerEventTypes.map((t) => enumLabel('QualifyingEventType', t)).join(', ')}{' '}
              · {approvalModeLabel(policy.requiresApproval)}
              {fixedLevels > 0
                ? ` · ${fixedLevels} fixed ${fixedLevels === 1 ? 'level' : 'levels'}`
                : ''}
            </dd>
          </div>
        </dl>
      </section>

      <FormRadioCards
        control={form.control}
        name="when"
        label="When should it take effect?"
        options={[
          {
            value: 'NOW',
            label: 'Now',
            description: 'Applies to sales from the moment you publish.',
          },
          {
            value: 'SCHEDULE',
            label: 'Schedule for later',
            description: `Choose a start time in the program's time zone (${tz}).`,
          },
        ]}
      />

      {when === 'SCHEDULE' ? (
        <FormDateTimeField
          control={form.control}
          name="effectiveFrom"
          label="Effective from"
          timeZone={tz}
          min={new Date(openedAt).toISOString()}
          required
        />
      ) : null}

      <div className="space-y-1.5 text-sm">
        <p className="font-medium">What changes on the timeline</p>
        <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
          <li>
            {current ? (
              <>
                The version in effect at that moment ends exactly then — today that is version{' '}
                {current.version} ({current.name}).
              </>
            ) : (
              <>Any version in effect at that moment ends exactly then.</>
            )}
          </li>
          <li>
            {nextScheduled ? (
              <>
                Version {nextScheduled.version} is already scheduled to start on{' '}
                <DateTime value={nextScheduled.effectiveFrom} timeZone={tz} showTimeZone />, so this
                version will end at that time.
              </>
            ) : (
              <>It stays in effect until another version is published (open-ended).</>
            )}
          </li>
          <li>
            Sales are priced by the version in effect when they happened; past rewards never change.
          </li>
        </ul>
      </div>

      <div aria-live="polite" className="space-y-2">
        {preview.isFetching || validate.isPending ? (
          <p className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-3.5" aria-hidden />
            Checking the policy for this start time…
          </p>
        ) : !hasErrors && issues.length === 0 && preview.data ? (
          <p className="inline-flex items-center gap-1.5 text-xs text-success">
            <CircleCheck className="size-3.5" aria-hidden />
            All checks passed.
          </p>
        ) : null}
        {preview.error && !blockingIssues ? (
          <p className="text-xs text-muted-foreground">
            Couldn&apos;t run the checks ({getErrorMessage(preview.error)}). They run again when you
            publish.
          </p>
        ) : null}
        <PolicyIssueList
          issues={issues}
          labelFor={(path) => issueFieldLabel(path, policy.rules)}
          announce={Boolean(blockingIssues)}
          errorTitle={hasErrors ? 'Fix these issues in the draft before publishing' : undefined}
        />
      </div>

      {autoApproveBlocked ? (
        <Alert variant="destructive">
          <ShieldAlert aria-hidden />
          <AlertTitle>Only a Super Admin can publish this version</AlertTitle>
          <AlertDescription>
            It approves rewards from API and webhook sales automatically. Turn manual approval back
            on in the draft (save it) or ask a Super Admin to publish it.
          </AlertDescription>
        </Alert>
      ) : null}

      <AcknowledgeField control={form.control} />

      {submitError ? (
        <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {submitError}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={submitting || autoApproveBlocked || (hasErrors && !blockingIssues)}
        >
          {submitting ? <Spinner aria-hidden /> : <Rocket aria-hidden />}
          {when === 'SCHEDULE' ? 'Schedule version' : 'Publish now'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function AcknowledgeField({
  control,
}: {
  control: Control<PublishValues, unknown, PublishOutput>;
}) {
  const {
    field: { ref: fieldRef, ...field },
    fieldState,
  } = useController({ control, name: 'acknowledged' });
  const id = useId();
  const error = fieldState.error?.message;
  return (
    <Field orientation="horizontal" data-invalid={error ? true : undefined}>
      <Checkbox
        id={id}
        ref={fieldRef}
        checked={Boolean(field.value)}
        onCheckedChange={(checked) => field.onChange(checked === true)}
        onBlur={field.onBlur}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      <div className="grid gap-1">
        <FieldLabel htmlFor={id} className="font-normal">
          I understand published policies cannot be edited
        </FieldLabel>
        {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
      </div>
    </Field>
  );
}
