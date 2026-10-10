'use client';

/**
 * Policy-specific form controls built on the form kit's `FormItem` (labels, descriptions, errors and
 * aria wiring): percentages entered as text and stored as integer basis points, whole numbers,
 * numeric selects, a checkbox group and descriptive radio cards.
 */
import { useId, useState, type ReactNode } from 'react';
import { useController, type FieldPath, type FieldValues } from 'react-hook-form';

import { describedBy, FormItem, type BaseFormFieldProps } from '@/components/app/form';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@/components/ui/field';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

import { bpsToPercentText, parseWholeNumber, percentTextToBps } from '../format';

// ─── Percentage (basis points) ───────────────────────────────────────────────

export interface FormPercentFieldProps<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
  TTransformed = TFieldValues,
> extends BaseFormFieldProps<TFieldValues, TName, TTransformed> {
  placeholder?: string;
  /** Text after the "%" addon, e.g. "of the sale". */
  suffix?: string;
  inputClassName?: string;
}

/**
 * Percentage input whose form value is integer basis points (`12.5` → `1250`) or `null` when empty /
 * invalid. Parsing is string based (no floats); up to two decimals.
 */
export function FormPercentField<
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
  placeholder = '0',
  suffix,
  inputClassName,
}: FormPercentFieldProps<TFieldValues, TName, TTransformed>) {
  const {
    field: { ref: fieldRef, ...field },
    fieldState,
  } = useController({ control, name, disabled });
  const id = useId();

  const toDisplay = (value: unknown): string =>
    typeof value === 'number' && Number.isInteger(value) ? bpsToPercentText(value) : '';

  const [display, setDisplay] = useState(() => toDisplay(field.value));
  const [localError, setLocalError] = useState<string | null>(null);
  // Re-sync when the value changes from outside (reset / setValue). "Adjust state during render".
  const [synced, setSynced] = useState<unknown>(field.value);
  if (synced !== field.value) {
    setSynced(field.value);
    const current = display.trim() ? percentTextToBps(display) : null;
    if (current !== field.value) {
      setDisplay(toDisplay(field.value));
      setLocalError(null);
    }
  }

  const commit = (value: number | null) => {
    setSynced(value);
    field.onChange(value);
  };

  const handleChange = (text: string) => {
    setDisplay(text);
    if (!text.trim()) {
      setLocalError(null);
      commit(null);
      return;
    }
    const bps = percentTextToBps(text);
    if (bps === null) {
      setLocalError('Enter a percentage with up to two decimals, e.g. 12.5');
      commit(null);
      return;
    }
    setLocalError(null);
    commit(bps);
  };

  const handleBlur = () => {
    if (!localError && typeof field.value === 'number') setDisplay(bpsToPercentText(field.value));
    field.onBlur();
  };

  const error = localError ?? fieldState.error?.message;

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
      <InputGroup className={cn('sm:max-w-48', inputClassName)}>
        <InputGroupInput
          id={id}
          name={field.name}
          ref={fieldRef}
          inputMode="decimal"
          autoComplete="off"
          placeholder={placeholder}
          value={display}
          onChange={(event) => handleChange(event.target.value)}
          onBlur={handleBlur}
          disabled={field.disabled}
          className="tabular-nums"
          aria-invalid={error ? true : undefined}
          aria-required={required || undefined}
          aria-describedby={describedBy(id, Boolean(description), Boolean(error))}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupText>{suffix ? `% ${suffix}` : '%'}</InputGroupText>
        </InputGroupAddon>
      </InputGroup>
    </FormItem>
  );
}

// ─── Whole number ────────────────────────────────────────────────────────────

export interface FormWholeNumberFieldProps<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
  TTransformed = TFieldValues,
> extends BaseFormFieldProps<TFieldValues, TName, TTransformed> {
  placeholder?: string;
  /** Trailing addon text (unit). */
  suffix?: ReactNode;
  max?: number;
}

/** Integer input; the form value is a number, or `null` when empty / invalid. */
export function FormWholeNumberField<
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
  placeholder = '0',
  suffix,
  max,
}: FormWholeNumberFieldProps<TFieldValues, TName, TTransformed>) {
  const {
    field: { ref: fieldRef, ...field },
    fieldState,
  } = useController({ control, name, disabled });
  const id = useId();

  const toDisplay = (value: unknown): string =>
    typeof value === 'number' && Number.isInteger(value) ? String(value) : '';

  const [display, setDisplay] = useState(() => toDisplay(field.value));
  const [localError, setLocalError] = useState<string | null>(null);
  const [synced, setSynced] = useState<unknown>(field.value);
  if (synced !== field.value) {
    setSynced(field.value);
    const current = display.trim() ? parseWholeNumber(display, max) : null;
    if (current !== field.value) {
      setDisplay(toDisplay(field.value));
      setLocalError(null);
    }
  }

  const commit = (value: number | null) => {
    setSynced(value);
    field.onChange(value);
  };

  const handleChange = (text: string) => {
    setDisplay(text);
    if (!text.trim()) {
      setLocalError(null);
      commit(null);
      return;
    }
    const value = parseWholeNumber(text, max);
    if (value === null) {
      setLocalError(
        max ? `Enter a whole number up to ${max.toLocaleString('en')}.` : 'Enter a whole number.',
      );
      commit(null);
      return;
    }
    setLocalError(null);
    commit(value);
  };

  const error = localError ?? fieldState.error?.message;

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
      <InputGroup className="sm:max-w-80">
        <InputGroupInput
          id={id}
          name={field.name}
          ref={fieldRef}
          inputMode="numeric"
          autoComplete="off"
          placeholder={placeholder}
          value={display}
          onChange={(event) => handleChange(event.target.value)}
          onBlur={field.onBlur}
          disabled={field.disabled}
          className="tabular-nums"
          aria-invalid={error ? true : undefined}
          aria-required={required || undefined}
          aria-describedby={describedBy(id, Boolean(description), Boolean(error))}
        />
        {suffix ? (
          <InputGroupAddon align="inline-end">
            <InputGroupText>{suffix}</InputGroupText>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
    </FormItem>
  );
}

// ─── Numeric select ──────────────────────────────────────────────────────────

export interface NumberOption {
  value: number;
  label: string;
  disabled?: boolean;
}

export interface FormNumberSelectProps<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
  TTransformed = TFieldValues,
> extends BaseFormFieldProps<TFieldValues, TName, TTransformed> {
  options: readonly NumberOption[];
  placeholder?: string;
  triggerClassName?: string;
}

/** Select whose form value is a number (levels, depth). */
export function FormNumberSelect<
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
  triggerClassName,
}: FormNumberSelectProps<TFieldValues, TName, TTransformed>) {
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
        value={typeof field.value === 'number' ? String(field.value) : ''}
        onValueChange={(value) => field.onChange(Number(value))}
        onOpenChange={(open) => {
          if (!open) field.onBlur();
        }}
        disabled={field.disabled}
      >
        <SelectTrigger
          id={id}
          ref={fieldRef}
          className={cn('w-full', triggerClassName)}
          aria-invalid={error ? true : undefined}
          aria-required={required || undefined}
          aria-describedby={describedBy(id, Boolean(description), Boolean(error))}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent position="popper">
          {options.map((option) => (
            <SelectItem key={option.value} value={String(option.value)} disabled={option.disabled}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormItem>
  );
}

// ─── Checkbox group ──────────────────────────────────────────────────────────

export interface ChoiceOption<V extends string = string> {
  value: V;
  label: string;
  description?: ReactNode;
}

export interface FormCheckboxGroupProps<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
  TTransformed = TFieldValues,
> extends BaseFormFieldProps<TFieldValues, TName, TTransformed> {
  options: readonly ChoiceOption[];
}

/** Multi-select over a string-array field, as a fieldset of checkboxes (canonical option order). */
export function FormCheckboxGroup<
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
  className,
  options,
}: FormCheckboxGroupProps<TFieldValues, TName, TTransformed>) {
  const {
    field: { ref: fieldRef, ...field },
    fieldState,
  } = useController({ control, name, disabled });
  const id = useId();
  const error = fieldState.error?.message;
  const selected: readonly string[] = Array.isArray(field.value) ? (field.value as string[]) : [];

  const toggle = (value: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(value);
    else next.delete(value);
    field.onChange(options.map((option) => option.value).filter((v) => next.has(v)));
  };

  return (
    <FieldSet
      className={className}
      data-invalid={error ? true : undefined}
      aria-describedby={describedBy(id, Boolean(description), Boolean(error))}
    >
      <FieldLegend variant="label">
        {label}
        {required ? (
          <span aria-hidden className="ml-0.5 text-destructive">
            *
          </span>
        ) : null}
      </FieldLegend>
      {description ? (
        <FieldDescription id={`${id}-description`}>{description}</FieldDescription>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:gap-x-6">
        {options.map((option, index) => {
          const optionId = `${id}-${option.value}`;
          return (
            <Field key={option.value} orientation="horizontal" className="w-auto">
              <Checkbox
                id={optionId}
                ref={index === 0 ? fieldRef : undefined}
                checked={selected.includes(option.value)}
                onCheckedChange={(checked) => toggle(option.value, checked === true)}
                onBlur={field.onBlur}
                disabled={field.disabled}
                aria-invalid={error ? true : undefined}
              />
              <FieldLabel htmlFor={optionId} className="font-normal">
                {option.label}
              </FieldLabel>
            </Field>
          );
        })}
      </div>
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </FieldSet>
  );
}

// ─── Radio cards ─────────────────────────────────────────────────────────────

export interface FormRadioCardsProps<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
  TTransformed = TFieldValues,
> extends BaseFormFieldProps<TFieldValues, TName, TTransformed> {
  options: readonly ChoiceOption[];
  /** Grid classes for the cards (default: two columns from `sm`). */
  gridClassName?: string;
}

/** Single choice with a title + explanation per option (choice cards). */
export function FormRadioCards<
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
  gridClassName,
}: FormRadioCardsProps<TFieldValues, TName, TTransformed>) {
  const {
    field: { ref: fieldRef, ...field },
    fieldState,
  } = useController({ control, name, disabled });
  const id = useId();
  const error = fieldState.error?.message;

  return (
    <FieldSet className={className} data-invalid={error ? true : undefined}>
      <FieldLegend variant="label" className={cn(hideLabel && 'sr-only')}>
        {label}
        {required ? (
          <span aria-hidden className="ml-0.5 text-destructive">
            *
          </span>
        ) : null}
      </FieldLegend>
      {description ? (
        <FieldDescription id={`${id}-description`}>{description}</FieldDescription>
      ) : null}
      <RadioGroup
        name={field.name}
        value={typeof field.value === 'string' ? field.value : ''}
        onValueChange={field.onChange}
        onBlur={field.onBlur}
        disabled={field.disabled}
        className={cn('grid gap-2 sm:grid-cols-2', gridClassName)}
        aria-describedby={describedBy(id, Boolean(description), Boolean(error))}
        aria-invalid={error ? true : undefined}
      >
        {options.map((option, index) => {
          const optionId = `${id}-${option.value}`;
          return (
            <FieldLabel key={option.value} htmlFor={optionId}>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldTitle>{option.label}</FieldTitle>
                  {option.description ? (
                    <FieldDescription>{option.description}</FieldDescription>
                  ) : null}
                </FieldContent>
                <RadioGroupItem
                  value={option.value}
                  id={optionId}
                  ref={index === 0 ? fieldRef : undefined}
                />
              </Field>
            </FieldLabel>
          );
        })}
      </RadioGroup>
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </FieldSet>
  );
}
