'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Info } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { activateEnrollmentSchema, type AdminEnrollmentDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { FormAmountField, FormTextField, applyApiFieldErrors } from '@/components/app/form';
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
import { enumLabel } from '@/lib/enum-labels';

import { useActivateEnrollment } from '../api';

/** Activation needs at least the plan price (the API refuses less). */
function formSchema(priceMinor: bigint) {
  return activateEnrollmentSchema.superRefine((v, ctx) => {
    if (!/^\d+$/.test(v.paymentAmountMinor)) return;
    if (priceMinor > BigInt(0) && BigInt(v.paymentAmountMinor) < priceMinor) {
      ctx.addIssue({ code: 'custom', path: ['paymentAmountMinor'], message: 'Less than the plan price' });
    }
  });
}
type FormInput = z.input<typeof activateEnrollmentSchema>;
type FormOutput = z.output<typeof activateEnrollmentSchema>;

/** Records the offline payment of a PENDING enrollment and activates it. Mount per open. */
export function ActivateEnrollmentDialogContent({ enrollment, onDone }: { enrollment: AdminEnrollmentDto; onDone: () => void }) {
  const activate = useActivateEnrollment();
  const price = BigInt(enrollment.option.priceMinor);
  const currency = { currencyCode: enrollment.program.currencyCode, minorUnits: enrollment.program.currencyMinorUnits };
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(formSchema(price)),
    defaultValues: { paymentReference: '', paymentAmountMinor: enrollment.option.priceMinor },
  });

  async function onSubmit(values: FormOutput) {
    try {
      const updated = await activate.mutateAsync({ id: enrollment.id, input: values });
      toast.success('Enrollment activated', {
        description: updated.upcoming
          ? 'Coverage starts when the member’s current period ends.'
          : `${enrollment.member.fullName} now has an active ${enrollment.option.name} plan.`,
      });
      onDone();
    } catch (error) {
      if (!applyApiFieldErrors(error, form.setError)) toast.error(getErrorMessage(error));
    }
  }

  return (
    <DialogContent className="sm:max-w-md">
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="contents">
        <DialogHeader>
          <DialogTitle>Record payment and activate</DialogTitle>
          <DialogDescription>Confirm the offline payment you received for this plan.</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 rounded-lg border p-3 text-sm">
          <dt className="text-muted-foreground">Member</dt>
          <dd className="truncate">{enrollment.member.fullName}</dd>
          <dt className="text-muted-foreground">Program</dt>
          <dd className="truncate">{enrollment.program.name}</dd>
          <dt className="text-muted-foreground">Plan</dt>
          <dd>
            {enrollment.option.name} · {enumLabel('BillingFrequency', enrollment.option.billingFrequency)} ·{' '}
            {enrollment.option.durationDays} days
          </dd>
          <dt className="text-muted-foreground">Plan price</dt>
          <dd>
            <Amount kind="currency" value={enrollment.option.priceMinor} format={currency} />
          </dd>
        </dl>
        <FieldGroup>
          <FormTextField
            control={form.control}
            name="paymentReference"
            label="Payment reference"
            description="Bank/UPI transaction id or receipt number. Must be unique; it can never be reused as a sale id."
            maxLength={128}
            autoComplete="off"
            spellCheck={false}
            required
          />
          <FormAmountField
            control={form.control}
            name="paymentAmountMinor"
            label="Amount received"
            currencyCode={currency.currencyCode}
            minorUnits={currency.minorUnits}
            required
          />
        </FieldGroup>
        <p className="flex gap-2 rounded-lg bg-muted/60 p-2.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          A member’s plan payment is never a qualifying sale and never generates rewards for anyone. The payment record cannot be edited
          after activation.
        </p>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDone} disabled={activate.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={activate.isPending}>
            {activate.isPending ? <Spinner aria-hidden /> : null}
            Activate enrollment
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
