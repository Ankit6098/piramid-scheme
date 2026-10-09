'use client';

import { useId } from 'react';
import { useController, type FieldPath, type FieldValues } from 'react-hook-form';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { describedBy, FormItem, type BaseFormFieldProps } from './form-item';

export interface SelectOption {
  /** Must be a non-empty string (Radix Select reserves ""). */
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface FormSelectProps<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
  TTransformed = TFieldValues,
> extends BaseFormFieldProps<TFieldValues, TName, TTransformed> {
  options: readonly SelectOption[];
  placeholder?: string;
}

/**
 * Single-choice select bound to react-hook-form. For enums use `enumOptions("ProgramStatus")`.
 *
 * @example <FormSelect control={form.control} name="billingFrequency" label="Billing" options={enumOptions("BillingFrequency")} />
 */
export function FormSelect<
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
  options,
  placeholder = 'Select…',
}: FormSelectProps<TFieldValues, TName, TTransformed>) {
  const {
    field: { ref: fieldRef, ...field },
    fieldState,
  } = useController({ control, name, disabled });
  const id = useId();
  const error = fieldState.error?.message;

  return (
    <FormItem
      id={id}
      label={label}
      description={description}
      error={error}
      required={required}
      disabled={field.disabled}
      hideLabel={hideLabel}
      className={className}
    >
      <Select
        name={field.name}
        value={(field.value as string | undefined) ?? ''}
        onValueChange={field.onChange}
        onOpenChange={(open) => {
          if (!open) field.onBlur();
        }}
        disabled={field.disabled}
      >
        <SelectTrigger
          id={id}
          ref={fieldRef}
          className="w-full"
          aria-invalid={error ? true : undefined}
          aria-required={required || undefined}
          aria-describedby={describedBy(id, Boolean(description), Boolean(error))}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent position="popper">
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormItem>
  );
}
