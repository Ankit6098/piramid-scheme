'use client';

import { useId, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { reasonSchema } from '@app/shared';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { getErrorMessage } from '@/lib/api-client';

/** Anything with Zod's `safeParse` that validates the trimmed reason text. */
export interface ReasonValidator {
  safeParse: (value: unknown) => {
    success: boolean;
    error?: { issues: ReadonlyArray<{ message: string }> };
  };
}

export interface ConfirmReasonOptions {
  /** Defaults to true — most audited actions need a reason (≥ 10 characters, see `reasonSchema`). */
  required?: boolean;
  label?: string;
  placeholder?: string;
  /** Help text under the field. Defaults to an admin/audit-log hint built from `minLength`. */
  description?: ReactNode;
  /**
   * Validation of the (trimmed) text, matching the API's schema for this action — e.g.
   * `financeReasonSchema` (≤ 480) or `cancelMyEnrollmentSchema.shape.reason` (optional, ≤ 500).
   * Defaults to `reasonSchema` (10–1000), or to `minLength`/`maxLength` when those are given.
   */
  schema?: ReasonValidator;
  /** Minimum length (default 10). Builds the default schema and help text. */
  minLength?: number;
  /** Maximum length (default 1000): the textarea limit, and part of the default schema. */
  maxLength?: number;
}

const DEFAULT_REASON_MIN = 10;
const DEFAULT_REASON_MAX = 1000;

function reasonValidator(options: ConfirmReasonOptions): ReasonValidator {
  if (options.schema) return options.schema;
  const min = options.minLength ?? DEFAULT_REASON_MIN;
  const max = options.maxLength ?? DEFAULT_REASON_MAX;
  if (min === DEFAULT_REASON_MIN && max === DEFAULT_REASON_MAX) return reasonSchema;
  let schema = z.string().trim();
  if (min > 0) schema = schema.min(min, `Please give a reason (at least ${min} characters)`);
  return schema.max(max, `Keep it under ${max} characters`);
}

function defaultReasonHelp(min: number): string {
  return min > 0
    ? `At least ${min} characters. Visible to other administrators.`
    : 'Visible to other administrators.';
}

export interface ConfirmDialogProps {
  /** Controlled open state (omit both to use `trigger`). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Element that opens the dialog (rendered with `asChild`). */
  trigger?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Extra content between the description and the inputs (summary of what will change). */
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `destructive` styles the confirm button red. */
  variant?: 'default' | 'destructive';
  /** Ask for a reason (audited actions). Pass `true` for the defaults. */
  reason?: boolean | ConfirmReasonOptions;
  /**
   * For dangerous, irreversible actions: the user must type this exact text (e.g. the program
   * code or "REVERSE") before confirming.
   */
  typedConfirmation?: string;
  /**
   * Runs on confirm. While the returned promise is pending the dialog stays open and shows a
   * spinner; it closes on success and shows the error inline on failure (the promise should
   * reject with an `ApiError`).
   */
  onConfirm: (input: { reason?: string }) => void | Promise<unknown>;
}

/** Confirmation dialog for consequential actions, with optional reason + typed confirmation. */
export function ConfirmDialog({
  open: openProp,
  onOpenChange,
  trigger,
  title,
  description,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  reason,
  typedConfirmation,
  onConfirm,
}: ConfirmDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openProp ?? internalOpen;
  const [reasonText, setReasonText] = useState('');
  const [typed, setTyped] = useState('');
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const reasonId = useId();
  const typedId = useId();

  const reasonOptions: ConfirmReasonOptions | null = reason === true ? {} : reason ? reason : null;
  const reasonRequired = reasonOptions ? (reasonOptions.required ?? true) : false;
  const reasonMax = reasonOptions?.maxLength ?? DEFAULT_REASON_MAX;
  const reasonResult = reasonOptions ? reasonValidator(reasonOptions).safeParse(reasonText) : null;
  const reasonError =
    reasonOptions && reasonResult && (reasonRequired || reasonText.trim().length > 0) && !reasonResult.success
      ? (reasonResult.error?.issues[0]?.message ?? 'Please give a reason')
      : null;
  const typedOk = !typedConfirmation || typed.trim() === typedConfirmation;
  const canConfirm = !pending && !reasonError && typedOk;

  function setOpen(next: boolean) {
    if (pending) return; // don't close mid-request
    if (!next) {
      setReasonText('');
      setTyped('');
      setTouched(false);
      setSubmitError(null);
    }
    if (openProp === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  }

  async function handleConfirm() {
    setTouched(true);
    if (!canConfirm) return;
    setSubmitError(null);
    setPending(true);
    try {
      await onConfirm({ reason: reasonOptions ? reasonText.trim() || undefined : undefined });
      setPending(false);
      setOpenAfterSuccess();
    } catch (error) {
      setPending(false);
      setSubmitError(getErrorMessage(error));
    }
  }

  function setOpenAfterSuccess() {
    setReasonText('');
    setTyped('');
    setTouched(false);
    if (openProp === undefined) setInternalOpen(false);
    onOpenChange?.(false);
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      {trigger ? <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger> : null}
      <AlertDialogContent className="sm:max-w-md">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void handleConfirm();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
          </AlertDialogHeader>

          {children ? <div className="text-sm">{children}</div> : null}

          {reasonOptions ? (
            <Field data-invalid={touched && reasonError ? true : undefined}>
              <FieldLabel htmlFor={reasonId}>
                {reasonOptions.label ?? 'Reason'}
                {reasonRequired ? (
                  <span aria-hidden className="text-destructive">
                    *
                  </span>
                ) : null}
              </FieldLabel>
              <Textarea
                id={reasonId}
                value={reasonText}
                onChange={(e) => setReasonText(e.target.value)}
                onBlur={() => setTouched(true)}
                placeholder={
                  reasonOptions.placeholder ?? 'Explain why — this is recorded in the audit log.'
                }
                maxLength={reasonMax}
                rows={3}
                required={reasonRequired}
                aria-invalid={touched && reasonError ? true : undefined}
                aria-describedby={`${reasonId}-desc`}
                disabled={pending}
              />
              <FieldDescription id={`${reasonId}-desc`}>
                {reasonOptions.description ??
                  defaultReasonHelp(reasonOptions.minLength ?? DEFAULT_REASON_MIN)}
              </FieldDescription>
              {touched && reasonError ? <FieldError>{reasonError}</FieldError> : null}
            </Field>
          ) : null}

          {typedConfirmation ? (
            <Field>
              <FieldLabel htmlFor={typedId}>
                Type{' '}
                <code className="rounded bg-muted px-1 font-mono text-xs">{typedConfirmation}</code>{' '}
                to confirm
              </FieldLabel>
              <Input
                id={typedId}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={pending}
              />
            </Field>
          ) : null}

          {submitError ? (
            <p
              role="alert"
              className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {submitError}
            </p>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel type="button" disabled={pending}>
              {cancelLabel}
            </AlertDialogCancel>
            <Button
              type="submit"
              variant={variant === 'destructive' ? 'destructive' : 'default'}
              // Stays clickable while the reason is invalid so the click reveals the inline error.
              disabled={pending || !typedOk}
            >
              {pending ? <Spinner aria-hidden /> : null}
              {confirmLabel}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
