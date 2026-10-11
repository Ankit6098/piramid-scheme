'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Info } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { OfferingKind, offeringSkuSchema, type OfferingDto, type UpdateOfferingInput } from '@app/shared';

import {
  FormSelect,
  FormTextarea,
  FormTextField,
  applyApiFieldErrors,
} from '@/components/app/form';
import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field';
import {
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { getErrorMessage } from '@/lib/api-client';
import { enumOptions } from '@/lib/enum-labels';

import { useCreateOffering, useUpdateOffering } from '../api';

const schema = z.object({
  name: z.string().trim().min(2, 'Enter at least 2 characters').max(160),
  kind: z.enum(OfferingKind, 'Choose a kind'),
  sku: z.union([offeringSkuSchema, z.literal('')]),
  description: z.string().trim().max(2000),
});
type FormInput = z.input<typeof schema>;
type FormOutput = z.output<typeof schema>;

export interface OfferingSheetContentProps {
  /** Edit this offering; omit to create one. */
  offering?: OfferingDto;
  onDone: () => void;
}

/**
 * Create / edit form for an offering, rendered inside a `<Sheet>` owned by the caller (mount it per
 * open so the form starts fresh).
 */
export function OfferingSheetContent({ offering, onDone }: OfferingSheetContentProps) {
  const create = useCreateOffering();
  const update = useUpdateOffering();
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: offering?.name ?? '',
      kind: offering?.kind ?? ('' as unknown as OfferingKind),
      sku: offering?.sku ?? '',
      description: offering?.description ?? '',
    },
  });
  const pending = create.isPending || update.isPending;

  async function onSubmit(values: FormOutput) {
    try {
      if (offering) {
        const input: UpdateOfferingInput = {};
        if (values.name !== offering.name) input.name = values.name;
        if (values.kind !== offering.kind) input.kind = values.kind;
        if ((values.sku || null) !== offering.sku) input.sku = values.sku;
        if ((values.description || null) !== offering.description) input.description = values.description;
        if (Object.keys(input).length === 0) {
          onDone();
          return;
        }
        await update.mutateAsync({ id: offering.id, input });
        toast.success('Offering updated');
      } else {
        await create.mutateAsync(values);
        toast.success('Offering created', { description: 'It stays inactive until a Super Admin approves it.' });
      }
      onDone();
    } catch (error) {
      if (!applyApiFieldErrors(error, form)) toast.error(getErrorMessage(error));
    }
  }

  return (
    <SheetContent className="w-full gap-0 sm:max-w-lg">
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex h-full flex-col">
        <SheetHeader className="border-b">
          <SheetTitle>{offering ? 'Edit offering' : 'New offering'}</SheetTitle>
          <SheetDescription>
            An offering is a product or service sold to end customers. Rewards can only ever come from its qualifying sales.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          {!offering ? (
            <p className="flex gap-2 rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              New offerings start inactive. A Super Admin must approve an offering before a program can be published with it or its
              sales can be recorded.
            </p>
          ) : offering.status === 'ACTIVE' ? (
            <p className="flex gap-2 rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              This offering is approved{offering.liveProgramCount > 0 ? ` and used by ${offering.liveProgramCount} live program(s)` : ''}.
              Changes are recorded in the audit log.
            </p>
          ) : null}
          <FieldGroup>
            <FormTextField control={form.control} name="name" label="Name" maxLength={160} required autoComplete="off" />
            <FormSelect control={form.control} name="kind" label="Kind" options={enumOptions('OfferingKind')} required />
            <FormTextField
              control={form.control}
              name="sku"
              label="SKU"
              description="Optional catalogue identifier, unique across offerings."
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
            />
            <FormTextarea control={form.control} name="description" label="Description" maxLength={2000} showCount rows={5} />
          </FieldGroup>
        </div>
        <SheetFooter className="flex-row justify-end border-t">
          <Button type="button" variant="outline" onClick={onDone} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? <Spinner aria-hidden /> : null}
            {offering ? 'Save changes' : 'Create offering'}
          </Button>
        </SheetFooter>
      </form>
    </SheetContent>
  );
}
