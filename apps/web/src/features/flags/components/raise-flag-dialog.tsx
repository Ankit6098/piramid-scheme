'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { FlagTriangleRight } from 'lucide-react';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { createFlagSchema, type CreateFlagInput } from '@app/shared';
import type { z } from 'zod';

import { applyApiFieldErrors, FormTextarea } from '@/components/app/form';
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { getErrorMessage } from '@/lib/api-client';

import { MemberPicker, type PickedMember } from '../../hierarchy/components/member-picker';
import { useRaiseFlag } from '../api';

/** Raises a MANUAL_REPORT flag about a member (`flags:manage`). */
export function RaiseFlagDialog({ defaultUserId }: { defaultUserId?: string }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<PickedMember | null>(null);
  const pickerId = useId();
  const mutation = useRaiseFlag();
  const form = useForm<z.input<typeof createFlagSchema>, unknown, CreateFlagInput>({
    resolver: zodResolver(createFlagSchema),
    defaultValues: { userId: defaultUserId ?? '', details: '' },
  });

  function close() {
    setOpen(false);
    form.reset({ userId: defaultUserId ?? '', details: '' });
    setPicked(null);
    mutation.reset();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : !mutation.isPending && close())}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <FlagTriangleRight aria-hidden />
          Raise flag
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form
          className="contents"
          noValidate
          onSubmit={form.handleSubmit((values) =>
            mutation.mutate(values, {
              onSuccess: () => {
                toast.success('Flag raised');
                close();
              },
              onError: (error) => {
                if (!applyApiFieldErrors(error, form.setError)) toast.error(getErrorMessage(error));
              },
            }),
          )}
        >
          <DialogHeader>
            <DialogTitle>Raise a flag</DialogTitle>
            <DialogDescription>
              Record a concern about a member for review. Flags are advisory and never change balances.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={form.formState.errors.userId ? true : undefined}>
              <FieldLabel htmlFor={pickerId}>
                Member
                <span aria-hidden className="text-destructive">
                  *
                </span>
              </FieldLabel>
              <MemberPicker
                id={pickerId}
                value={picked}
                onChange={(member) => {
                  setPicked(member);
                  form.setValue('userId', member?.id ?? '', { shouldValidate: form.formState.isSubmitted });
                }}
                invalid={Boolean(form.formState.errors.userId)}
                describedBy={`${pickerId}-desc`}
                disabled={mutation.isPending}
              />
              <FieldDescription id={`${pickerId}-desc`}>Search by name or email, or paste a member ID.</FieldDescription>
              {form.formState.errors.userId ? <FieldError>Choose the member this flag is about.</FieldError> : null}
            </Field>
            <FormTextarea control={form.control} name="details" label="Details" rows={4} maxLength={2000} showCount required />
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? <Spinner aria-hidden /> : null}
              Raise flag
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
