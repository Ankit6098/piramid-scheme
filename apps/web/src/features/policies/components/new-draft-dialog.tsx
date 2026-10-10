'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import type { PolicyVersionDto, PolicyVersionSummaryDto } from '@app/shared';

import { applyApiFieldErrors, FormSelect, FormTextField } from '@/components/app/form';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FieldGroup } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { getErrorMessage } from '@/lib/api-client';

import { useCreatePolicyDraft } from '../api';
import { phaseMeta } from '../labels';

const DEFAULTS = 'defaults';

const newDraftSchema = z.object({
  name: z
    .string()
    .trim()
    .max(160, 'At most 160 characters')
    .refine(
      (value) => value.length === 0 || value.length >= 2,
      'Name must be at least 2 characters',
    ),
  source: z.string().min(1),
});
type NewDraftValues = z.input<typeof newDraftSchema>;
type NewDraftOutput = z.output<typeof newDraftSchema>;

export interface NewDraftDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  programId: string;
  /** Versions that can be cloned (any status). */
  versions: readonly PolicyVersionSummaryDto[];
  /** Pre-selected source (usually the version in effect). */
  defaultSourceId?: string | null;
  onCreated: (policy: PolicyVersionDto) => void;
}

/** "New draft" — blank (platform defaults) or cloned from any existing version. */
export function NewDraftDialog({ open, onOpenChange, ...props }: NewDraftDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* Mounted per open, so the form starts fresh every time. */}
        {open ? <NewDraftForm {...props} onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function NewDraftForm({
  programId,
  versions,
  defaultSourceId,
  onCreated,
  onClose,
}: Omit<NewDraftDialogProps, 'open' | 'onOpenChange'> & { onClose: () => void }) {
  const create = useCreatePolicyDraft(programId);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const initialSource =
    defaultSourceId && versions.some((v) => v.id === defaultSourceId) ? defaultSourceId : DEFAULTS;

  const form = useForm<NewDraftValues, unknown, NewDraftOutput>({
    resolver: zodResolver(newDraftSchema),
    defaultValues: { name: '', source: initialSource },
  });

  const options = [
    { value: DEFAULTS, label: 'Blank draft (platform defaults)' },
    ...versions.map((version) => ({
      value: version.id,
      label: `Copy of version ${version.version} · ${version.name} (${phaseMeta(version.phase).label})`,
    })),
  ];

  const onSubmit = form.handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      const policy = await create.mutateAsync({
        name: values.name || undefined,
        cloneFromVersionId: values.source === DEFAULTS ? undefined : values.source,
      });
      toast.success(`Draft version ${policy.version} created`);
      onClose();
      onCreated(policy);
    } catch (error) {
      if (!applyApiFieldErrors(error, form.setError)) setSubmitError(getErrorMessage(error));
    }
  });

  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate className="grid gap-4">
      <DialogHeader>
        <DialogTitle>New draft</DialogTitle>
        <DialogDescription>
          Drafts are private working copies. Nothing changes for sales until a draft is published.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <FormSelect
          control={form.control}
          name="source"
          label="Start from"
          options={options}
          description="Copying a version copies all of its settings and reward levels."
        />
        <FormTextField
          control={form.control}
          name="name"
          label="Name"
          placeholder="Leave empty for an automatic name"
          maxLength={160}
          autoComplete="off"
        />
      </FieldGroup>
      {submitError ? (
        <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {submitError}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={create.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? <Spinner aria-hidden /> : null}
          Create draft
        </Button>
      </DialogFooter>
    </form>
  );
}
