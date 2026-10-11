'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Lock } from 'lucide-react';
import { useEffect } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  BillingFrequency,
  DEFAULT_OPTION_DURATION,
  OPTION_DURATION_RANGES,
  optionDurationIssue,
  RenewalPolicy,
  type AdminProgramDetailDto,
  type ProgramOptionDto,
  type UpdateProgramOptionInput,
} from '@app/shared';

import { FormAmountField, FormSelect, FormTextarea, FormTextField, applyApiFieldErrors } from '@/components/app/form';
import { Button } from '@/components/ui/button';
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FieldGroup } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { getErrorMessage } from '@/lib/api-client';
import { enumOptions } from '@/lib/enum-labels';

import { useCreateOption, useUpdateOption } from '../../api';

const schema = z
  .object({
    name: z.string().trim().min(1, 'Enter a name').max(120),
    description: z.string().trim().max(1000),
    priceMinor: z.string().regex(/^\d{1,18}$/, 'Enter a price (0 for a free plan)'),
    billingFrequency: z.enum(BillingFrequency),
    durationDays: z.string().trim().regex(/^\d+$/, 'Use whole days'),
    renewalPolicy: z.enum(RenewalPolicy),
  })
  .superRefine((v, ctx) => {
    const issue = optionDurationIssue(v.billingFrequency, Number(v.durationDays));
    if (issue) ctx.addIssue({ code: 'custom', path: ['durationDays'], message: issue });
  });
type FormInput = z.input<typeof schema>;
type FormOutput = z.output<typeof schema>;

export interface OptionDialogContentProps {
  program: AdminProgramDetailDto;
  /** Edit this option; omit to add one. */
  option?: ProgramOptionDto;
  onDone: () => void;
}

/** Add / edit a plan. Mount it inside a `<Dialog>` per open so the form starts fresh. */
export function OptionDialogContent({ program, option, onDone }: OptionDialogContentProps) {
  const create = useCreateOption(program.id);
  const update = useUpdateOption(program.id);
  const pending = create.isPending || update.isPending;
  const termsLocked = option?.termsLocked ?? false;

  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(schema),
    defaultValues: option
      ? {
          name: option.name,
          description: option.description ?? '',
          priceMinor: option.priceMinor,
          billingFrequency: option.billingFrequency,
          durationDays: String(option.durationDays),
          renewalPolicy: option.renewalPolicy,
        }
      : { name: '', description: '', priceMinor: '', billingFrequency: 'MONTHLY', durationDays: '30', renewalPolicy: 'MANUAL' },
  });
  const frequency = useWatch({ control: form.control, name: 'billingFrequency' });
  const range = OPTION_DURATION_RANGES[frequency];

  // When the billing frequency changes and the duration no longer fits, suggest the typical one.
  useEffect(() => {
    if (termsLocked) return;
    if (optionDurationIssue(frequency, Number(form.getValues('durationDays')))) {
      form.setValue('durationDays', String(DEFAULT_OPTION_DURATION[frequency]), { shouldDirty: true });
    }
  }, [frequency, termsLocked, form]);

  async function onSubmit(v: FormOutput) {
    try {
      if (option) {
        const input: UpdateProgramOptionInput = {};
        if (v.name !== option.name) input.name = v.name;
        if ((v.description || null) !== option.description) input.description = v.description || null;
        if (!termsLocked) {
          if (v.priceMinor !== option.priceMinor) input.priceMinor = v.priceMinor;
          if (v.billingFrequency !== option.billingFrequency) input.billingFrequency = v.billingFrequency;
          if (Number(v.durationDays) !== option.durationDays) input.durationDays = Number(v.durationDays);
        }
        if (v.renewalPolicy !== option.renewalPolicy) input.renewalPolicy = v.renewalPolicy;
        if (Object.keys(input).length > 0) {
          await update.mutateAsync({ optionId: option.id, input });
          toast.success('Option updated');
        }
      } else {
        await create.mutateAsync({
          name: v.name,
          description: v.description || null,
          priceMinor: v.priceMinor,
          billingFrequency: v.billingFrequency,
          durationDays: Number(v.durationDays),
          renewalPolicy: v.renewalPolicy,
        });
        toast.success('Option added');
      }
      onDone();
    } catch (error) {
      if (!applyApiFieldErrors(error, form)) toast.error(getErrorMessage(error));
    }
  }

  return (
    <DialogContent className="sm:max-w-lg">
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="contents">
        <DialogHeader>
          <DialogTitle>{option ? 'Edit option' : 'Add option'}</DialogTitle>
          <DialogDescription>
            A plan members buy to access {program.offering.name}. The price pays for the plan — it is not a deposit, and enrolling never
            earns rewards.
          </DialogDescription>
        </DialogHeader>
        {termsLocked ? (
          <p className="flex items-start gap-2 rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
            <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {option?.enrollmentCount} member enrollment(s) use this option, so its price, billing and duration are locked. Create a new
            option to offer different terms.
          </p>
        ) : null}
        <FieldGroup>
          <FormTextField control={form.control} name="name" label="Name" maxLength={120} required />
          <FormTextarea control={form.control} name="description" label="Description" rows={3} maxLength={1000} showCount />
          <FormAmountField
            control={form.control}
            name="priceMinor"
            label="Price"
            currencyCode={program.currencyCode}
            minorUnits={program.currencyMinorUnits}
            description={`In ${program.currencyCode}. Enter 0 for a free plan (activated immediately).`}
            required
            disabled={termsLocked}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <FormSelect
              control={form.control}
              name="billingFrequency"
              label="Billing"
              options={enumOptions('BillingFrequency')}
              required
              disabled={termsLocked}
            />
            <FormTextField
              control={form.control}
              name="durationDays"
              label="Duration (days)"
              inputMode="numeric"
              description={range.min === 1 ? `1–${range.max} days` : `${range.min}–${range.max} days`}
              required
              disabled={termsLocked}
            />
          </div>
          <FormSelect
            control={form.control}
            name="renewalPolicy"
            label="Renewal"
            options={enumOptions('RenewalPolicy')}
            description="Whether members may queue another period after this one. Payments are collected offline."
            required
          />
        </FieldGroup>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDone} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? <Spinner aria-hidden /> : null}
            {option ? 'Save option' : 'Add option'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
