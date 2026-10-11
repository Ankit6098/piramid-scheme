'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  History,
  Info,
  Loader,
  ShieldCheck,
  Undo2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useController, useForm, useFormState, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  ErrorCode,
  isoDateTimeSchema,
  positiveMinorAmountSchema,
  QualifyingEventType,
  recordSaleSchema,
  type QualifyingEventStatus,
  type RecordSaleResultDto,
  type SaleEventDetailDto,
  type SaleProgramOptionDto,
} from '@app/shared';

import { Amount } from '@/components/app/amount';
import {
  applyApiFieldErrors,
  describedBy,
  FormAmountField,
  FormDateTimeField,
  FormItem,
  FormSelect,
  FormTextarea,
  FormTextField,
  useUnsavedChangesWarning,
} from '@/components/app/form';
import { EmptyState } from '@/components/app/states';
import { StatusBadge } from '@/components/app/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field';
import {
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useSession } from '@/hooks/use-session';
import { createIdempotencyKey, getErrorMessage, isApiError } from '@/lib/api-client';
import { enumLabel, enumOptions } from '@/lib/enum-labels';
import { cn } from '@/lib/utils';

import { MemberPicker, type PickedMember } from '../../hierarchy/components/member-picker';
import { useRecordSale } from '../api';
import { pluralize, programCurrencyFormat, programOptionLabel, programRewardFormat } from '../labels';

// ─── Form schema ─────────────────────────────────────────────────────────────

/** Sales may be dated at most this far ahead (mirrors the API and the DB check). */
const FUTURE_SALE_TOLERANCE_MS = 5 * 60_000;

/** `recordSaleSchema` with friendlier messages for empty fields (same output shape). */
export const recordSaleFormSchema = recordSaleSchema.extend({
  programId: z.uuid({ error: 'Select a program' }),
  subjectUserId: z
    .string()
    .trim()
    .min(1, 'Choose the member credited with the sale')
    .pipe(z.uuid({ error: 'Choose a member from the list' })),
  amountMinor: z.string().min(1, 'Enter the sale amount').pipe(positiveMinorAmountSchema),
  occurredAt: z
    .string()
    .min(1, 'Enter when the sale happened')
    .pipe(isoDateTimeSchema)
    // Same tolerance as the API (5 minutes of clock skew); validated on submit, not during render.
    .refine((value) => new Date(value).getTime() <= Date.now() + FUTURE_SALE_TOLERANCE_MS, {
      message: 'The sale date cannot be in the future',
    }),
});

export type RecordSaleFormInput = z.input<typeof recordSaleFormSchema>;
type RecordSaleFormOutput = z.output<typeof recordSaleFormSchema>;

const FORM_FIELDS = [
  'programId',
  'type',
  'externalId',
  'customerReference',
  'subjectUserId',
  'amountMinor',
  'occurredAt',
  'description',
] as const satisfies readonly (keyof RecordSaleFormInput)[];

// ─── Session (one per sheet open) ────────────────────────────────────────────

export interface RecordSaleSupersedes {
  id: string;
  externalId: string;
  revision: number;
  status: QualifyingEventStatus;
}

export interface RecordSaleSession {
  /** Changes on every open → fresh form state and a fresh Idempotency-Key. */
  id: string;
  defaults: RecordSaleFormInput;
  /** The member credited in `defaults.subjectUserId` (shown by the member picker). */
  subject?: PickedMember;
  /** Set for "Re-record" of a rejected/reversed sale. */
  supersedes?: RecordSaleSupersedes;
}

function emptyDefaults(nowIso: string, keep?: Partial<RecordSaleFormInput>): RecordSaleFormInput {
  return {
    programId: keep?.programId ?? '',
    type: keep?.type ?? QualifyingEventType[0],
    externalId: '',
    customerReference: '',
    subjectUserId: '',
    amountMinor: '',
    occurredAt: nowIso,
    description: '',
  };
}

/**
 * Builds a session for an open of the sheet. Call from event handlers (reads the clock).
 * `prefill` = a rejected/reversed sale to re-record (its facts + `supersedesEventId`).
 */
export function createRecordSaleSession(
  options: { programId?: string; prefill?: SaleEventDetailDto } = {},
): RecordSaleSession {
  const { prefill } = options;
  const nowIso = new Date().toISOString();
  if (!prefill) {
    return { id: createIdempotencyKey(), defaults: emptyDefaults(nowIso, { programId: options.programId }) };
  }
  return {
    id: createIdempotencyKey(),
    defaults: {
      programId: prefill.programId,
      type: prefill.type,
      externalId: prefill.externalId,
      customerReference: prefill.customerReference,
      subjectUserId: prefill.subject.id,
      amountMinor: prefill.amountMinor,
      occurredAt: prefill.occurredAt,
      description: prefill.description ?? '',
    },
    subject: { id: prefill.subject.id, fullName: prefill.subject.fullName },
    supersedes: {
      id: prefill.id,
      externalId: prefill.externalId,
      revision: prefill.revision,
      status: prefill.status,
    },
  };
}

// ─── Result panel ────────────────────────────────────────────────────────────

interface OutcomeView {
  icon: LucideIcon;
  tone: 'success' | 'muted' | 'destructive' | 'info';
  title: string;
  body: ReactNode;
}

function outcomeView(result: RecordSaleResultDto): OutcomeView {
  const { event } = result;
  switch (result.outcome) {
    case 'REWARDS_CREATED': {
      const pending = event.rewards.some((r) => r.status === 'PENDING_APPROVAL');
      return {
        icon: CircleCheck,
        tone: 'success',
        title: `${pluralize(event.rewardCount, 'reward')} created`,
        body: (
          <>
            Total <Amount value={event.rewardTotalMinor} format={programRewardFormat(event.program)} />
            {pending
              ? '. They are pending approval by a second reviewer before they are posted to the ledger.'
              : '.'}
          </>
        ),
      };
    }
    case 'NO_ELIGIBLE_RECIPIENTS':
      return {
        icon: CircleDashed,
        tone: 'muted',
        title: 'Recorded — no eligible recipients',
        body: 'No upline member was eligible at the sale date, so no rewards were created.',
      };
    case 'REJECTED':
      return {
        icon: CircleAlert,
        tone: 'destructive',
        title: 'Stored as rejected — no rewards',
        body: (
          <>
            <span className="block font-medium text-destructive">
              {event.rejectionReason ?? 'No reason was given.'}
            </span>
            <span className="mt-1 block">
              The sale was stored as rejected for the record. Correct the details and re-record it.
            </span>
          </>
        ),
      };
    case 'PENDING':
      return {
        icon: Loader,
        tone: 'info',
        title: 'Recorded — processing',
        body: 'Rewards are being calculated. Refresh the list in a minute or two.',
      };
    case 'REVERSED':
    default:
      return {
        icon: Undo2,
        tone: 'muted',
        title: 'This sale is reversed',
        body: event.reversalReason ?? 'Its rewards were rejected or reversed.',
      };
  }
}

const TONE_CLASS: Record<OutcomeView['tone'], string> = {
  success: 'border-success/30 bg-success/5 [&>svg]:text-success',
  muted: 'border-border bg-muted/40 [&>svg]:text-muted-foreground',
  destructive: 'border-destructive/40 bg-destructive/5 [&>svg]:text-destructive',
  info: 'border-info/30 bg-info/5 [&>svg]:text-info',
};

function RecordSaleResultPanel({ result }: { result: RecordSaleResultDto }) {
  const view = outcomeView(result);
  const Icon = view.icon;
  const { event } = result;
  return (
    <div className="space-y-4" role="status" aria-live="polite">
      {result.replayed ? (
        <Alert role="note">
          <History aria-hidden />
          <AlertTitle>Already recorded</AlertTitle>
          <AlertDescription>
            This sale was already recorded — showing the existing record.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className={cn('flex items-start gap-3 rounded-xl border p-4', TONE_CLASS[view.tone])}>
        <Icon className="mt-0.5 size-5 shrink-0" aria-hidden />
        <div className="min-w-0 space-y-1">
          <p className="font-medium">{view.title}</p>
          <p className="text-sm text-muted-foreground">{view.body}</p>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border p-4">
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">External id</dt>
          <dd className="truncate font-mono text-sm">
            {event.externalId}
            {event.revision > 0 ? (
              <span className="text-muted-foreground"> · rev {event.revision}</span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Status</dt>
          <dd>
            <StatusBadge kind="QualifyingEventStatus" value={event.status} />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">Program</dt>
          <dd className="truncate text-sm">{event.program.name}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Amount</dt>
          <dd className="text-sm font-medium">
            <Amount
              kind="currency"
              value={event.amountMinor}
              format={programCurrencyFormat(event.program, event.currencyCode)}
            />
          </dd>
        </div>
        <div className="col-span-2 min-w-0">
          <dt className="text-xs text-muted-foreground">Member credited</dt>
          <dd className="truncate text-sm">{event.subject.fullName}</dd>
        </div>
      </dl>
    </div>
  );
}

// ─── Sheet content ───────────────────────────────────────────────────────────

function errorReason(details: unknown): string | undefined {
  if (details && typeof details === 'object' && 'reason' in details) {
    const reason = (details as { reason?: unknown }).reason;
    return typeof reason === 'string' ? reason : undefined;
  }
  return undefined;
}

export interface RecordSaleSheetContentProps {
  session: RecordSaleSession;
  open: boolean;
  /** All programs visible to the caller (only `canRecordSales` ones are offered). */
  programs: readonly SaleProgramOptionDto[] | undefined;
  programsLoading: boolean;
  programsError: unknown;
  onRetryPrograms: () => void;
  onClose: () => void;
  onViewEvent: (eventId: string) => void;
}

/**
 * Body of the "Record sale" sheet. Render inside `<Sheet>` keyed by `session.id` so each open gets
 * a fresh form and a fresh Idempotency-Key (reused on retries within the same open).
 */
export function RecordSaleSheetContent({
  session,
  open,
  programs,
  programsLoading,
  programsError,
  onRetryPrograms,
  onClose,
  onViewEvent,
}: RecordSaleSheetContentProps) {
  const formId = useId();
  const subjectInputId = useId();
  const { user } = useSession();
  const [idempotencyKey, setIdempotencyKey] = useState(createIdempotencyKey);
  const [subject, setSubject] = useState<PickedMember | null>(session.subject ?? null);
  const [supersedes, setSupersedes] = useState(session.supersedes);
  const [result, setResult] = useState<RecordSaleResultDto | null>(null);
  const mutation = useRecordSale();

  const form = useForm<RecordSaleFormInput, unknown, RecordSaleFormOutput>({
    resolver: zodResolver(recordSaleFormSchema),
    defaultValues: session.defaults,
  });
  const { isDirty } = useFormState({ control: form.control });
  useUnsavedChangesWarning(form, { enabled: open && !result });
  const subjectField = useController({ control: form.control, name: 'subjectUserId' });
  const subjectError = subjectField.fieldState.error?.message;

  const recordable = (programs ?? []).filter((p) => p.canRecordSales);
  const programId = useWatch({ control: form.control, name: 'programId' });
  const program = recordable.find((p) => p.id === programId);

  // A different program may use a different currency: clear the amount when the program changes.
  useEffect(() => {
    let previous = form.getValues('programId');
    return form.subscribe({
      name: 'programId',
      formState: { values: true },
      callback: ({ values }) => {
        if (values.programId === previous) return;
        if (previous) form.setValue('amountMinor', '', { shouldDirty: true });
        previous = values.programId;
      },
    });
  }, [form]);

  const pending = mutation.isPending;

  function canDismiss(): boolean {
    if (pending) return false;
    if (result || !isDirty) return true;
    return window.confirm('Discard this sale? The details you entered will be lost.');
  }

  function requestClose() {
    if (canDismiss()) onClose();
  }

  function handleError(error: unknown) {
    if (isApiError(error)) {
      if (error.code === ErrorCode.IdempotencyConflict) {
        const message = 'A sale with this external id already exists with different details';
        form.setError('externalId', { type: 'server', message: `${message}.` }, { shouldFocus: true });
        toast.error(message, {
          description: 'Check the external id, or find the existing sale with the search box.',
        });
        return;
      }
      if (error.isConflict && errorReason(error.details) === 'RECORDER_SOD') {
        toast.error(error.message);
        return;
      }
      if (error.hasFieldErrors) {
        // A currency mismatch is reported on `currencyCode`, which the form derives from the program.
        const currencyError = error.fieldErrors.currencyCode;
        if (currencyError) {
          form.setError('amountMinor', { type: 'server', message: currencyError });
        }
        const applied = applyApiFieldErrors(error, form.setError, { knownFields: FORM_FIELDS });
        const unknown = Object.entries(error.fieldErrors).find(
          ([path]) => path !== 'currencyCode' && !(FORM_FIELDS as readonly string[]).includes(path),
        );
        if (applied || currencyError || unknown) {
          toast.error('Some fields need attention', {
            description: unknown ? unknown[1] : error.message,
          });
          return;
        }
      }
    }
    toast.error("Couldn't record the sale", { description: getErrorMessage(error) });
  }

  function onSubmit(values: RecordSaleFormOutput) {
    if (!program) {
      form.setError('programId', { message: 'Select a program you can record sales for' });
      return;
    }
    mutation.mutate(
      {
        input: {
          ...values,
          description: values.description ? values.description : undefined,
          currencyCode: program.currencyCode,
          supersedesEventId: supersedes?.id,
        },
        idempotencyKey,
      },
      {
        onSuccess: (res) => {
          setResult(res);
          const view = outcomeView(res);
          if (res.outcome === 'REJECTED') {
            toast.warning('Sale stored as rejected', {
              description: res.event.rejectionReason ?? undefined,
            });
          } else {
            toast.success(res.replayed ? 'Sale already recorded' : 'Sale recorded', {
              description: view.title,
            });
          }
        },
        onError: handleError,
      },
    );
  }

  function recordAnother() {
    const current = form.getValues();
    form.reset(emptyDefaults(new Date().toISOString(), { programId: current.programId, type: current.type }));
    setIdempotencyKey(createIdempotencyKey());
    setSupersedes(undefined);
    setSubject(null);
    setResult(null);
    mutation.reset();
  }

  const title = supersedes ? 'Re-record sale' : 'Record sale';

  let body: ReactNode;
  if (result) {
    body = <RecordSaleResultPanel result={result} />;
  } else if (programsLoading) {
    body = (
      <div className="space-y-5" aria-hidden>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-8 w-full" />
          </div>
        ))}
      </div>
    );
  } else if (programsError && !programs) {
    body = (
      <EmptyState
        variant="plain"
        icon={CircleAlert}
        title="Couldn't load programs"
        description={getErrorMessage(programsError)}
        action={
          <Button variant="outline" onClick={onRetryPrograms}>
            Try again
          </Button>
        }
      />
    );
  } else if (recordable.length === 0) {
    body = (
      <EmptyState
        variant="plain"
        icon={ShieldCheck}
        title="No programs you can record sales for"
        description="Sales can be recorded only for programs you administer. Ask a Super Admin to assign you to a program."
      />
    );
  } else {
    body = (
      <form id={formId} onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-5">
        {supersedes ? (
          <Alert role="note">
            <History aria-hidden />
            <AlertTitle>
              Re-recording {supersedes.externalId}
              {supersedes.revision > 0 ? ` (rev ${supersedes.revision})` : ''}
            </AlertTitle>
            <AlertDescription>
              <p>
                The original sale is {enumLabel('QualifyingEventStatus', supersedes.status).toLowerCase()}.
                The new record is stored as the next revision and supersedes it. Correct the details
                before submitting.
              </p>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto px-0"
                onClick={() => setSupersedes(undefined)}
              >
                Record as an unrelated sale instead
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        <Alert role="note" className="bg-muted/40">
          <Info aria-hidden />
          <AlertTitle>Only qualifying sales</AlertTitle>
          <AlertDescription>
            Record a sale of the program&apos;s approved offering to an end customer. A member&apos;s
            own plan payment is never a sale — such entries are rejected.
          </AlertDescription>
        </Alert>
        <FieldGroup>
          <FormSelect
            control={form.control}
            name="programId"
            label="Program"
            placeholder="Select a program"
            options={recordable.map((p) => ({
              value: p.id,
              label: programOptionLabel(p, enumLabel('ProgramStatus', p.status)),
            }))}
            required
            disabled={pending}
          />
          <FormSelect
            control={form.control}
            name="type"
            label="Sale type"
            options={enumOptions('QualifyingEventType')}
            required
            disabled={pending}
          />
          <div className="grid gap-5 sm:grid-cols-2">
            <FormTextField
              control={form.control}
              name="externalId"
              label="Order / invoice id"
              description="The sale's id in your sales system."
              maxLength={128}
              autoComplete="off"
              spellCheck={false}
              required
              disabled={pending}
            />
            <FormTextField
              control={form.control}
              name="customerReference"
              label="End-customer reference"
              description="Customer id or invoice party."
              maxLength={128}
              autoComplete="off"
              spellCheck={false}
              required
              disabled={pending}
            />
          </div>
          <FormItem
            id={subjectInputId}
            label="Member credited"
            description="The active member credited with the sale; rewards go to their eligible upline."
            error={subjectError}
            required
            disabled={pending}
          >
            <MemberPicker
              id={subjectInputId}
              value={subject}
              onChange={(member) => {
                setSubject(member);
                subjectField.field.onChange(member?.id ?? '');
              }}
              status="ACTIVE"
              // Recorder segregation of duties: never yourself (the API also refuses your downline).
              excludeIds={user ? [user.id] : []}
              invalid={Boolean(subjectError)}
              describedBy={describedBy(subjectInputId, true, Boolean(subjectError))}
              disabled={pending}
            />
          </FormItem>
          <FormAmountField
            control={form.control}
            name="amountMinor"
            label="Sale amount"
            kind="currency"
            currencyCode={program?.currencyCode}
            minorUnits={program?.currencyMinorUnits}
            description={
              program
                ? `In ${program.currencyCode}, the program currency.`
                : 'Select a program first.'
            }
            required
            disabled={pending || !program}
          />
          <FormDateTimeField
            control={form.control}
            name="occurredAt"
            label="Occurred at"
            description="When the sale happened (not when it is entered)."
            timeZone={program?.timezone}
            required
            disabled={pending}
          />
          <FormTextarea
            control={form.control}
            name="description"
            label="Description"
            description="Optional note for other administrators."
            maxLength={500}
            showCount
            rows={3}
            disabled={pending}
          />
        </FieldGroup>
      </form>
    );
  }

  return (
    <SheetContent
      side="right"
      showCloseButton={false}
      className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
      onEscapeKeyDown={(event) => {
        if (!canDismiss()) event.preventDefault();
      }}
      onInteractOutside={(event) => {
        if (!canDismiss()) event.preventDefault();
      }}
    >
      <SheetHeader className="border-b pr-12">
        <SheetTitle>{title}</SheetTitle>
        <SheetDescription>
          Rewards are calculated only from qualifying sales, under the policy in effect when the
          sale happened.
        </SheetDescription>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute top-3 right-3"
          onClick={requestClose}
          disabled={pending}
          aria-label="Close"
        >
          <X aria-hidden />
        </Button>
      </SheetHeader>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">{body}</div>

      <SheetFooter className="flex-row flex-wrap justify-end border-t">
        {result ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Done
            </Button>
            <Button variant="outline" onClick={recordAnother}>
              Record another
            </Button>
            <Button onClick={() => onViewEvent(result.event.id)}>View sale</Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={requestClose} disabled={pending}>
              Cancel
            </Button>
            {recordable.length > 0 && !programsLoading ? (
              <Button type="submit" form={formId} disabled={pending}>
                {pending ? <Spinner aria-hidden /> : null}
                {pending ? 'Recording…' : title}
              </Button>
            ) : null}
          </>
        )}
      </SheetFooter>
    </SheetContent>
  );
}
