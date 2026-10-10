'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { CircleAlert, KeyRound, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { createApiClientSchema, type ApiClientDto, type SaleProgramOptionDto } from '@app/shared';

import { CopyButton } from '@/components/app/copy-button';
import { applyApiFieldErrors, FormSelect, FormTextField } from '@/components/app/form';
import { EmptyState } from '@/components/app/states';
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
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { getErrorMessage } from '@/lib/api-client';
import { enumLabel } from '@/lib/enum-labels';

import { programOptionLabel } from '@/features/events/labels';

import { useCreateApiClient } from '../api';
import { KeyPrefix } from './api-client-columns';

const formSchema = createApiClientSchema.extend({
  programId: z.uuid({ error: 'Select a program' }),
});
type FormInput = z.input<typeof formSchema>;
type FormOutput = z.output<typeof formSchema>;

interface Revealed {
  client: ApiClientDto;
  /** The full key — lives only in this component's state, cleared on close. */
  apiKey: string | null;
}

export interface CreateApiClientDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  programs: readonly SaleProgramOptionDto[] | undefined;
  programsLoading: boolean;
  programsError: unknown;
  onRetryPrograms: () => void;
}

/**
 * "New API client" → one-time key reveal. Mount with a new `key` per open so every open starts
 * with an empty form. The key is never written to the query cache or browser storage.
 */
export function CreateApiClientDialog({
  open,
  onOpenChange,
  programs,
  programsLoading,
  programsError,
  onRetryPrograms,
}: CreateApiClientDialogProps) {
  const formId = useId();
  const keyFieldId = useId();
  const ackId = useId();
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const mutation = useCreateApiClient();
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(formSchema),
    defaultValues: { programId: '', name: '' },
  });

  const options = (programs ?? []).filter((p) => p.status !== 'ARCHIVED');
  const pending = mutation.isPending;

  function handleOpenChange(next: boolean) {
    if (next) {
      onOpenChange(true);
      return;
    }
    if (pending) return;
    if (
      revealed?.apiKey &&
      !acknowledged &&
      !window.confirm(
        "You haven't confirmed that you stored the key. It will never be shown again. Close anyway?",
      )
    ) {
      return;
    }
    // Forget the secret right away (the dialog keeps its layout during the close animation).
    if (revealed) setRevealed({ ...revealed, apiKey: null });
    onOpenChange(false);
  }

  function onSubmit(values: FormOutput) {
    mutation.mutate(values, {
      onSuccess: (result) => {
        setRevealed({ client: result.client, apiKey: result.apiKey });
        // Drop the response (with the key) from the mutation cache.
        mutation.reset();
        toast.success('API client created', {
          description: 'Copy the key now — it is shown only once.',
        });
      },
      onError: (error) => {
        if (!applyApiFieldErrors(error, form.setError)) {
          toast.error("Couldn't create the API client", { description: getErrorMessage(error) });
        }
      },
    });
  }

  let content;
  if (revealed) {
    content = (
      <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-primary" aria-hidden />
            API key for {revealed.client.name}
          </DialogTitle>
          <DialogDescription>
            Store it in your secrets manager and configure it in the system that sends sales for{' '}
            {revealed.client.program.name}.
          </DialogDescription>
        </DialogHeader>

        <Alert className="border-warning/40 bg-warning/5 text-warning">
          <TriangleAlert aria-hidden />
          <AlertTitle>This key will never be shown again</AlertTitle>
          <AlertDescription>
            We store only a hash of it. If it is lost or exposed, revoke this client and create a
            new one.
          </AlertDescription>
        </Alert>

        <Field>
          <FieldLabel htmlFor={keyFieldId}>API key</FieldLabel>
          <div className="flex items-center gap-2">
            <Input
              id={keyFieldId}
              readOnly
              value={revealed.apiKey ?? '••••••••••••••••'}
              onFocus={(event) => event.currentTarget.select()}
              className="font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
            />
            {revealed.apiKey ? <CopyButton value={revealed.apiKey} label="API key" /> : null}
          </div>
        </Field>

        <p className="text-xs text-muted-foreground">
          Key prefix <KeyPrefix value={revealed.client.keyPrefix} /> — shown in the list so you can
          recognise the key later.
        </p>

        <Field orientation="horizontal">
          <Checkbox
            id={ackId}
            checked={acknowledged}
            onCheckedChange={(value) => setAcknowledged(value === true)}
          />
          <FieldLabel htmlFor={ackId} className="font-normal">
            I have stored the key securely
          </FieldLabel>
        </Field>

        <DialogFooter>
          <Button onClick={() => handleOpenChange(false)} disabled={!acknowledged}>
            Done
          </Button>
        </DialogFooter>
      </>
    );
  } else {
    let body;
    if (programsLoading) {
      body = (
        <div className="space-y-4" aria-hidden>
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      );
    } else if (programsError && !programs) {
      body = (
        <EmptyState
          variant="plain"
          size="sm"
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
    } else if (options.length === 0) {
      body = (
        <EmptyState
          variant="plain"
          size="sm"
          title="No programs yet"
          description="Create a program first — every API client submits sales for exactly one program."
        />
      );
    } else {
      body = (
        <form id={formId} onSubmit={form.handleSubmit(onSubmit)} noValidate>
          <FieldGroup>
            <FormSelect
              control={form.control}
              name="programId"
              label="Program"
              placeholder="Select a program"
              description="The key can submit sales only for this program."
              options={options.map((p) => ({
                value: p.id,
                label: programOptionLabel(p, enumLabel('ProgramStatus', p.status)),
              }))}
              required
              disabled={pending}
            />
            <FormTextField
              control={form.control}
              name="name"
              label="Name"
              description="Where the key is used, so you can recognise it later."
              placeholder="e.g. Web shop (production)"
              maxLength={120}
              autoComplete="off"
              required
              disabled={pending}
            />
          </FieldGroup>
        </form>
      );
    }

    content = (
      <>
        <DialogHeader>
          <DialogTitle>New API client</DialogTitle>
          <DialogDescription>
            An API client submits sales for exactly one program using a secret key.
          </DialogDescription>
        </DialogHeader>
        {body}
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          {options.length > 0 && !programsLoading ? (
            <Button type="submit" form={formId} disabled={pending}>
              {pending ? <Spinner aria-hidden /> : null}
              {pending ? 'Creating…' : 'Create client'}
            </Button>
          ) : null}
        </DialogFooter>
      </>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">{content}</DialogContent>
    </Dialog>
  );
}
