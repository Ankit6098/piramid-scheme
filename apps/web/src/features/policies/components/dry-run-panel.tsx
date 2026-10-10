'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { FlaskConical, Minus, Plus } from 'lucide-react';
import { useId, useState } from 'react';
import { useController, useFieldArray, useForm, useWatch, type Control } from 'react-hook-form';
import {
  DRY_RUN_MAX_ANCESTORS,
  QualifyingEventType,
  type DryRunPolicyInput,
  type PolicyChangesInput,
  type PolicyContextDto,
  type PolicyVersionDto,
} from '@app/shared';

import {
  applyApiFieldErrors,
  FormAmountField,
  FormDateTimeField,
  FormSelect,
  FormTextField,
} from '@/components/app/form';
import { ToneBadge } from '@/components/app/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { FieldDescription, FieldGroup, FieldLegend, FieldSet } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { getErrorMessage } from '@/lib/api-client';
import { enumLabel } from '@/lib/enum-labels';
import { cn } from '@/lib/utils';

import { useDryRunPolicy } from '../api';
import { dryRunFormSchema, type DryRunFormOutput, type DryRunFormValues } from '../form';
import { PanelSectionHeader } from './panel-section-header';
import { DryRunResultView } from './dry-run-result';

export interface DryRunPanelProps {
  policy: PolicyVersionDto;
  context: PolicyContextDto;
  /**
   * Unsaved draft edits in request shape (included as `changes`), `null` when the draft form
   * currently has errors (the saved draft is previewed), `undefined` for non-drafts.
   */
  changes?: PolicyChangesInput | null;
  /** The draft form differs from the saved draft. */
  hasUnsavedChanges?: boolean;
}

/**
 * Read-only preview of the calculator for this version: a sale amount + either a synthetic upline
 * (eligibility per depth) or a real member's tree. Nothing is recorded.
 */
export function DryRunPanel({ policy, context, changes, hasUnsavedChanges }: DryRunPanelProps) {
  const program = policy.program;
  const dryRun = useDryRunPolicy(policy.id);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [includedChanges, setIncludedChanges] = useState(false);
  const isDraft = policy.status === 'DRAFT';
  const headingId = useId();
  const triggerTypes = (changes?.triggerEventTypes ??
    policy.triggerEventTypes) as readonly string[];
  const depth = typeof changes?.maxDepth === 'number' ? changes.maxDepth : policy.maxDepth;

  const form = useForm<DryRunFormValues, unknown, DryRunFormOutput>({
    resolver: zodResolver(dryRunFormSchema),
    defaultValues: {
      eventType: policy.triggerEventTypes[0] ?? 'PRODUCT_SALE',
      saleAmountMinor: '',
      mode: 'SYNTHETIC',
      ancestors: Array.from({ length: Math.max(1, policy.maxDepth) }, () => ({ eligible: true })),
      subjectUserId: '',
      occurredAt: '',
    },
  });

  const eventTypeOptions = QualifyingEventType.map((type) => ({
    value: type,
    label: triggerTypes.includes(type)
      ? enumLabel('QualifyingEventType', type)
      : `${enumLabel('QualifyingEventType', type)} (not a trigger of this version)`,
  }));

  const onSubmit = form.handleSubmit(async (values) => {
    setSubmitError(null);
    const withChanges = isDraft && Boolean(changes);
    const input: DryRunPolicyInput = {
      eventType: values.eventType,
      saleAmountMinor: values.saleAmountMinor,
      ...(values.mode === 'SYNTHETIC'
        ? { ancestors: values.ancestors }
        : {
            subjectUserId: values.subjectUserId,
            occurredAt: values.occurredAt ? values.occurredAt : undefined,
          }),
      ...(withChanges && changes ? { changes } : {}),
    };
    try {
      await dryRun.mutateAsync(input);
      setIncludedChanges(withChanges && Boolean(hasUnsavedChanges));
    } catch (error) {
      const applied = applyApiFieldErrors(error, form.setError, {
        knownFields: ['eventType', 'saleAmountMinor', 'subjectUserId', 'occurredAt', 'ancestors'],
      });
      if (!applied) setSubmitError(getErrorMessage(error));
    }
  });

  return (
    <Card role="region" aria-labelledby={headingId}>
      <CardContent className="space-y-5">
        <PanelSectionHeader
          title={
            <span id={headingId} className="inline-flex items-center gap-2">
              <FlaskConical className="size-4 text-muted-foreground" aria-hidden />
              Dry run
            </span>
          }
          description="Preview how this version would share the reward budget of a sale."
          actions={
            <ToneBadge tone="info" dot={false}>
              Preview only — nothing is recorded
            </ToneBadge>
          }
        />

        {isDraft && hasUnsavedChanges ? (
          <p className="text-xs text-muted-foreground">
            {changes
              ? 'Your unsaved changes are included in the preview.'
              : 'The form has errors, so the preview uses the last saved draft.'}
          </p>
        ) : null}

        <form onSubmit={(event) => void onSubmit(event)} noValidate className="space-y-5">
          <FieldGroup className="grid gap-4 sm:grid-cols-2">
            <FormSelect
              control={form.control}
              name="eventType"
              label="Sale type"
              options={eventTypeOptions}
              required
            />
            <FormAmountField
              control={form.control}
              name="saleAmountMinor"
              label="Sale amount"
              kind="currency"
              currencyCode={program.currencyCode}
              minorUnits={program.currencyMinorUnits}
              required
            />
          </FieldGroup>

          <ModeTabs control={form.control} depth={depth} timeZone={program.timezone} />

          {submitError ? (
            <p
              role="alert"
              className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {submitError}
            </p>
          ) : null}

          <Button type="submit" disabled={dryRun.isPending}>
            {dryRun.isPending ? <Spinner aria-hidden /> : <FlaskConical aria-hidden />}
            Run preview
          </Button>
        </form>

        {dryRun.data ? (
          <div aria-live="polite" className={cn(dryRun.isPending && 'opacity-60')}>
            <DryRunResultView
              result={dryRun.data}
              pointsLabel={context.pointsLabel}
              timeZone={program.timezone}
              includesUnsavedChanges={includedChanges}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ModeTabs({
  control,
  depth,
  timeZone,
}: {
  control: Control<DryRunFormValues, unknown, DryRunFormOutput>;
  depth: number;
  timeZone: string;
}) {
  const { field } = useController({ control, name: 'mode' });
  return (
    <Tabs value={field.value} onValueChange={field.onChange}>
      <TabsList aria-label="Upline to preview">
        <TabsTrigger value="SYNTHETIC">Synthetic upline</TabsTrigger>
        <TabsTrigger value="MEMBER">Real member</TabsTrigger>
      </TabsList>
      <TabsContent value="SYNTHETIC" className="pt-2">
        <SyntheticChain control={control} depth={depth} />
      </TabsContent>
      <TabsContent value="MEMBER" className="pt-2">
        <FieldGroup className="grid gap-4 sm:grid-cols-2">
          <FormTextField
            control={control}
            name="subjectUserId"
            label="Member ID"
            placeholder="e.g. 3f2b8c1e-…"
            autoComplete="off"
            spellCheck={false}
            description="The member credited with the sale. Their real upline and its eligibility are used."
            required
          />
          <FormDateTimeField
            control={control}
            name="occurredAt"
            label="Sale time (optional)"
            timeZone={timeZone}
            description="Defaults to now. Eligibility is judged at this moment."
          />
        </FieldGroup>
      </TabsContent>
    </Tabs>
  );
}

function SyntheticChain({
  control,
  depth,
}: {
  control: Control<DryRunFormValues, unknown, DryRunFormOutput>;
  depth: number;
}) {
  const { fields, append, remove, replace } = useFieldArray({ control, name: 'ancestors' });
  const ancestors = useWatch({ control, name: 'ancestors' });
  const count = fields.length;
  const eligibleCount = ancestors?.filter((a) => a?.eligible).length ?? 0;

  return (
    <FieldSet>
      <FieldLegend variant="label">Upline members by depth</FieldLegend>
      <FieldDescription>
        Depth 1 is the seller&apos;s direct sponsor. Mark who would be eligible at the time of the
        sale ({eligibleCount} of {count} eligible). This version pays up to depth {depth}.
      </FieldDescription>
      {count > 0 ? (
        <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {fields.map((item, index) => (
            <AncestorToggle
              key={item.id}
              control={control}
              index={index}
              beyondDepth={index + 1 > depth}
            />
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">
          No upline members — the seller has no sponsor in this preview.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => append({ eligible: true }, { shouldFocus: false })}
          disabled={count >= DRY_RUN_MAX_ANCESTORS}
        >
          <Plus aria-hidden />
          Add depth
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => remove(count - 1)}
          disabled={count === 0}
        >
          <Minus aria-hidden />
          Remove deepest
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => replace(fields.map(() => ({ eligible: true })))}
          disabled={count === 0}
        >
          All eligible
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => replace(fields.map(() => ({ eligible: false })))}
          disabled={count === 0}
        >
          None eligible
        </Button>
      </div>
    </FieldSet>
  );
}

function AncestorToggle({
  control,
  index,
  beyondDepth,
}: {
  control: Control<DryRunFormValues, unknown, DryRunFormOutput>;
  index: number;
  beyondDepth: boolean;
}) {
  const {
    field: { ref: fieldRef, ...field },
  } = useController({ control, name: `ancestors.${index}.eligible` });
  const id = useId();
  const eligible = Boolean(field.value);
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
      <Label htmlFor={id} className="flex flex-col items-start gap-0 font-normal">
        <span className="text-sm font-medium">Depth {index + 1}</span>
        <span className={cn('text-xs', eligible ? 'text-success' : 'text-muted-foreground')}>
          {eligible ? 'Eligible' : 'Not eligible'}
          {beyondDepth ? ' · beyond max depth' : ''}
        </span>
      </Label>
      <Switch
        id={id}
        ref={fieldRef}
        checked={eligible}
        onCheckedChange={field.onChange}
        onBlur={field.onBlur}
        aria-label={`Upline member at depth ${index + 1} is eligible`}
      />
    </li>
  );
}
