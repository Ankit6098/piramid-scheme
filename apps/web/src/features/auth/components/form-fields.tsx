'use client';

/**
 * Auth-specific form controls on top of the form kit: a password input with a show/hide toggle and a
 * 6-digit one-time-code input (shadcn InputOTP), both bound to react-hook-form.
 */
import { REGEXP_ONLY_DIGITS } from 'input-otp';
import { Eye, EyeOff } from 'lucide-react';
import { useId, useState } from 'react';
import { useController, type FieldPath, type FieldValues } from 'react-hook-form';
import { OTP_CODE_LENGTH, PASSWORD_MIN_LENGTH } from '@app/shared';

import { describedBy, FormItem, type BaseFormFieldProps } from '@/components/app/form';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from '@/components/ui/input-otp';

export interface FormPasswordFieldProps<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
  TTransformed = TFieldValues,
> extends BaseFormFieldProps<TFieldValues, TName, TTransformed> {
  /** `current-password` (sign-in, re-authentication) or `new-password` (registration, reset). */
  autoComplete: 'current-password' | 'new-password';
  autoFocus?: boolean;
}

/** Password input with a visibility toggle. */
export function FormPasswordField<
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
  autoComplete,
  autoFocus,
}: FormPasswordFieldProps<TFieldValues, TName, TTransformed>) {
  const {
    field: { ref, ...field },
    fieldState,
  } = useController({ control, name, disabled });
  const [visible, setVisible] = useState(false);
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
      <InputGroup>
        <InputGroupInput
          id={id}
          ref={ref}
          name={field.name}
          type={visible ? 'text' : 'password'}
          value={(field.value as string | undefined) ?? ''}
          onChange={field.onChange}
          onBlur={field.onBlur}
          disabled={field.disabled}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-required={required || undefined}
          aria-describedby={describedBy(id, Boolean(description), Boolean(error))}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? 'Hide password' : 'Show password'}
            aria-pressed={visible}
            disabled={field.disabled}
          >
            {visible ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </FormItem>
  );
}

/** Helper text for new passwords (mirrors the server rule: ≥ 10 characters, a letter and a digit). */
export const NEW_PASSWORD_HINT = `At least ${PASSWORD_MIN_LENGTH} characters, including a letter and a number.`;

export interface FormOtpFieldProps<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
  TTransformed = TFieldValues,
> extends BaseFormFieldProps<TFieldValues, TName, TTransformed> {
  autoFocus?: boolean;
  /** Called once all 6 digits are entered (e.g. to submit automatically). */
  onComplete?: (code: string) => void;
}

/** 6-digit code input (digits only, paste-friendly, `autocomplete="one-time-code"`). */
export function FormOtpField<
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
  autoFocus,
  onComplete,
}: FormOtpFieldProps<TFieldValues, TName, TTransformed>) {
  const {
    field: { ref, ...field },
    fieldState,
  } = useController({ control, name, disabled });
  const id = useId();
  const error = fieldState.error?.message;
  const half = OTP_CODE_LENGTH / 2;

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
      <InputOTP
        id={id}
        ref={ref}
        name={field.name}
        maxLength={OTP_CODE_LENGTH}
        pattern={REGEXP_ONLY_DIGITS}
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus={autoFocus}
        value={(field.value as string | undefined) ?? ''}
        onChange={(value) => field.onChange(value)}
        onBlur={field.onBlur}
        onComplete={onComplete}
        disabled={field.disabled}
        aria-invalid={error ? true : undefined}
        aria-required={required || undefined}
        aria-describedby={describedBy(id, Boolean(description), Boolean(error))}
        containerClassName="justify-center sm:justify-start"
      >
        <InputOTPGroup>
          {Array.from({ length: half }, (_, i) => (
            <InputOTPSlot
              key={i}
              index={i}
              aria-invalid={error ? true : undefined}
              className="size-10 text-base"
            />
          ))}
        </InputOTPGroup>
        <InputOTPSeparator />
        <InputOTPGroup>
          {Array.from({ length: half }, (_, i) => (
            <InputOTPSlot
              key={i + half}
              index={i + half}
              aria-invalid={error ? true : undefined}
              className="size-10 text-base"
            />
          ))}
        </InputOTPGroup>
      </InputOTP>
    </FormItem>
  );
}
