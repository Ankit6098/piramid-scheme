'use client';

import { useId, type ComponentProps } from 'react';
import { useController, type FieldPath, type FieldValues } from 'react-hook-form';

import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

import { describedBy, FormItem, type BaseFormFieldProps } from './form-item';

type NativeTextareaProps = Omit<
  ComponentProps<'textarea'>,
  | 'name'
  | 'value'
  | 'defaultValue'
  | 'onChange'
  | 'onBlur'
  | 'ref'
  | 'disabled'
  | 'required'
  | 'id'
  | 'children'
>;

export interface FormTextareaProps<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
  TTransformed = TFieldValues,
>
  extends BaseFormFieldProps<TFieldValues, TName, TTransformed>, NativeTextareaProps {
  /** Show "120 / 1000" under the field (requires `maxLength`). */
  showCount?: boolean;
}

/** Multi-line text bound to react-hook-form. */
export function FormTextarea<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
  TTransformed = TFieldValues,
>({
  control,
  name,
  label,
  description,
  required,
  disabled,
  hideLabel,
  className,
  showCount,
  maxLength,
  rows = 4,
  ...textareaProps
}: FormTextareaProps<TFieldValues, TName, TTransformed>) {
  const {
    field: { ref: fieldRef, ...field },
    fieldState,
  } = useController({ control, name, disabled });
  const id = useId();
  const error = fieldState.error?.message;
  const value = (field.value as string | undefined) ?? '';

  return (
    <FormItem
      id={id}
      label={label}
      description={
        showCount && maxLength ? (
          <span className="flex justify-between gap-4">
            <span>{description}</span>
            <span
              className={cn('tabular-nums', value.length > maxLength && 'text-destructive')}
              aria-live="polite"
            >
              {value.length} / {maxLength}
            </span>
          </span>
        ) : (
          description
        )
      }
      error={error}
      required={required}
      disabled={field.disabled}
      hideLabel={hideLabel}
      className={className}
    >
      <Textarea
        {...textareaProps}
        id={id}
        rows={rows}
        maxLength={maxLength}
        name={field.name}
        value={value}
        onChange={field.onChange}
        onBlur={field.onBlur}
        ref={fieldRef}
        disabled={field.disabled}
        aria-invalid={error ? true : undefined}
        aria-required={required || undefined}
        aria-describedby={describedBy(
          id,
          Boolean(description || (showCount && maxLength)),
          Boolean(error),
        )}
      />
    </FormItem>
  );
}
