'use client';

import { useId } from 'react';
import { useController, type FieldPath, type FieldValues } from 'react-hook-form';

import { Switch } from '@/components/ui/switch';

import { describedBy, FormItem, type BaseFormFieldProps } from './form-item';

export type FormSwitchProps<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
  TTransformed = TFieldValues,
> = BaseFormFieldProps<TFieldValues, TName, TTransformed>;

/** Boolean toggle (label + description on the left, switch on the right). */
export function FormSwitch<
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
}: FormSwitchProps<TFieldValues, TName, TTransformed>) {
  const {
    field: { ref: fieldRef, ...field },
    fieldState,
  } = useController({ control, name, disabled });
  const id = useId();
  const error = fieldState.error?.message;

  return (
    <FormItem
      id={id}
      orientation="horizontal"
      label={label}
      description={description}
      error={error}
      required={required}
      disabled={field.disabled}
      hideLabel={hideLabel}
      className={className}
    >
      <Switch
        id={id}
        name={field.name}
        ref={fieldRef}
        checked={Boolean(field.value)}
        onCheckedChange={field.onChange}
        onBlur={field.onBlur}
        disabled={field.disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, Boolean(description), Boolean(error))}
      />
    </FormItem>
  );
}
