'use client';

import type { ReactNode } from 'react';
import type { Control, FieldPath, FieldValues } from 'react-hook-form';

import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import { cn } from '@/lib/utils';

/** RHF's form-context generic; `any` mirrors `useForm()`'s default so any form's `control` fits. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyFormContext = any;

/** Props shared by every `Form*Field` component. */
export interface BaseFormFieldProps<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
  TTransformed = TFieldValues,
> {
  /** `form.control` from `useForm()`. */
  control: Control<TFieldValues, AnyFormContext, TTransformed>;
  /** Field path, type-checked against the form values. */
  name: TName;
  label: ReactNode;
  /** Helper text under the control. */
  description?: ReactNode;
  /** Shows a required marker and sets `aria-required` (validation itself lives in the Zod schema). */
  required?: boolean;
  disabled?: boolean;
  /** Visually hide the label (it stays available to screen readers). */
  hideLabel?: boolean;
  className?: string;
}

export function fieldIds(id: string) {
  return { description: `${id}-description`, error: `${id}-error` };
}

/** `aria-describedby` for a control given which helper elements are rendered. */
export function describedBy(
  id: string,
  hasDescription: boolean,
  hasError: boolean,
): string | undefined {
  const ids = fieldIds(id);
  const list = [hasDescription ? ids.description : null, hasError ? ids.error : null].filter(
    Boolean,
  );
  return list.length ? list.join(' ') : undefined;
}

export function RequiredMark() {
  return (
    <span aria-hidden className="text-destructive">
      *
    </span>
  );
}

interface FormItemProps {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  error?: string;
  required?: boolean;
  disabled?: boolean;
  hideLabel?: boolean;
  orientation?: 'vertical' | 'horizontal';
  className?: string;
  children: ReactNode;
}

/** Label + control + helper text + inline error, wired with ids for assistive tech. */
export function FormItem({
  id,
  label,
  description,
  error,
  required,
  disabled,
  hideLabel,
  orientation = 'vertical',
  className,
  children,
}: FormItemProps) {
  const ids = fieldIds(id);
  const labelNode = (
    <FieldLabel htmlFor={id} className={cn(hideLabel && 'sr-only')}>
      {label}
      {required ? <RequiredMark /> : null}
    </FieldLabel>
  );

  if (orientation === 'horizontal') {
    return (
      <Field
        orientation="horizontal"
        data-invalid={error ? true : undefined}
        data-disabled={disabled ? true : undefined}
        className={className}
      >
        <FieldContent>
          {labelNode}
          {description ? (
            <FieldDescription id={ids.description}>{description}</FieldDescription>
          ) : null}
          {error ? <FieldError id={ids.error}>{error}</FieldError> : null}
        </FieldContent>
        {children}
      </Field>
    );
  }

  return (
    <Field
      data-invalid={error ? true : undefined}
      data-disabled={disabled ? true : undefined}
      className={className}
    >
      {labelNode}
      {children}
      {description ? <FieldDescription id={ids.description}>{description}</FieldDescription> : null}
      {error ? <FieldError id={ids.error}>{error}</FieldError> : null}
    </Field>
  );
}
