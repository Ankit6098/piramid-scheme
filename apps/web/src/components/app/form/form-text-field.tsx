'use client';

import { useId, type ComponentProps, type ReactNode } from 'react';
import { useController, type FieldPath, type FieldValues } from 'react-hook-form';

import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group';
import { Input } from '@/components/ui/input';

import { describedBy, FormItem, type BaseFormFieldProps } from './form-item';

type NativeInputProps = Omit<
  ComponentProps<'input'>,
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

export interface FormTextFieldProps<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
  TTransformed = TFieldValues,
>
  extends BaseFormFieldProps<TFieldValues, TName, TTransformed>, NativeInputProps {
  /** Leading addon (icon or text, e.g. "https://"). */
  startAddon?: ReactNode;
  /** Trailing addon (icon, unit, button). */
  endAddon?: ReactNode;
}

/**
 * Text-like input bound to react-hook-form (`type` = text, email, password, url, number, search…).
 *
 * @example <FormTextField control={form.control} name="fullName" label="Full name" autoComplete="name" required />
 */
export function FormTextField<
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
  startAddon,
  endAddon,
  type = 'text',
  ...inputProps
}: FormTextFieldProps<TFieldValues, TName, TTransformed>) {
  const {
    field: { ref: fieldRef, ...field },
    fieldState,
  } = useController({ control, name, disabled });
  const id = useId();
  const error = fieldState.error?.message;

  const controlProps = {
    ...inputProps,
    id,
    type,
    name: field.name,
    value: (field.value as string | number | undefined) ?? '',
    onChange: field.onChange,
    onBlur: field.onBlur,
    ref: fieldRef,
    disabled: field.disabled,
    'aria-invalid': error ? true : undefined,
    'aria-required': required || undefined,
    'aria-describedby': describedBy(id, Boolean(description), Boolean(error)),
  };

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
      {startAddon || endAddon ? (
        <InputGroup>
          <InputGroupInput {...controlProps} />
          {startAddon ? (
            <InputGroupAddon>
              <InputGroupText>{startAddon}</InputGroupText>
            </InputGroupAddon>
          ) : null}
          {endAddon ? (
            <InputGroupAddon align="inline-end">
              <InputGroupText>{endAddon}</InputGroupText>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
      ) : (
        <Input {...controlProps} />
      )}
    </FormItem>
  );
}
