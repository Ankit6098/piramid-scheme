'use client';

import { useId, useState } from 'react';
import { useController, type FieldPath, type FieldValues } from 'react-hook-form';
import { decimalToMinor, minorToDecimalString, unitSymbol, type RewardUnit } from '@app/shared';

import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group';
import { useAmountFormat } from '@/providers/platform-settings-provider';

import { describedBy, FormItem, type BaseFormFieldProps } from './form-item';

export interface FormAmountFieldProps<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
  TTransformed = TFieldValues,
> extends BaseFormFieldProps<TFieldValues, TName, TTransformed> {
  /**
   * `currency` (default) — prices / sale amounts in a currency. `reward` — amounts in the reward
   * unit (points are whole numbers, money uses the currency's minor units).
   */
  kind?: 'currency' | 'reward';
  /** Program currency (defaults to the platform currency). */
  currencyCode?: string;
  /** Override the currency's minor units (rarely needed). */
  minorUnits?: number;
  /** Program reward unit for `kind="reward"` (defaults to the platform reward unit). */
  unit?: RewardUnit;
  placeholder?: string;
  /** Value stored when the input is cleared (default `""`; use `null` for nullable API fields). */
  emptyValue?: '' | null;
}

/**
 * Decimal amount input whose form value is an integer **minor-units string** ("1500.50" with
 * 2 minor units → "150050"), ready for `minorAmountSchema` / `positiveMinorAmountSchema` from
 * `@app/shared`. Parsing uses `decimalToMinor` (no floats). Shows the currency symbol or points label.
 *
 * @example <FormAmountField control={form.control} name="priceMinor" label="Price" currencyCode={program.currencyCode} required />
 */
export function FormAmountField<
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
  kind = 'currency',
  currencyCode,
  minorUnits: minorUnitsProp,
  unit,
  placeholder,
  emptyValue = '',
}: FormAmountFieldProps<TFieldValues, TName, TTransformed>) {
  const {
    field: { ref: fieldRef, ...field },
    fieldState,
  } = useController({ control, name, disabled });
  const format = useAmountFormat(
    kind === 'currency'
      ? { unit: 'MONEY', currencyCode, minorUnits: minorUnitsProp }
      : { unit, currencyCode, minorUnits: minorUnitsProp },
  );
  const id = useId();
  const minorUnits = format?.minorUnits ?? 0;
  const ready = format !== null;

  const toDisplay = (value: unknown): string =>
    ready && typeof value === 'string' && /^\d+$/.test(value)
      ? minorToDecimalString(value, minorUnits)
      : '';

  const [display, setDisplay] = useState(() => toDisplay(field.value));
  const [localError, setLocalError] = useState<string | null>(null);
  // Re-sync the text when the form value changes from outside (reset/setValue) or when the
  // currency's minor units become known. ("Adjust state during render" pattern.)
  const [synced, setSynced] = useState({ value: field.value as unknown, minorUnits, ready });
  if (synced.value !== field.value || synced.minorUnits !== minorUnits || synced.ready !== ready) {
    setSynced({ value: field.value, minorUnits, ready });
    const current = display.trim() ? decimalToMinor(display, minorUnits)?.toString() : '';
    if (current !== field.value || synced.minorUnits !== minorUnits || synced.ready !== ready) {
      setDisplay(toDisplay(field.value));
      setLocalError(null);
    }
  }

  const commit = (value: string | null) => {
    setSynced({ value, minorUnits, ready });
    field.onChange(value);
  };

  const handleChange = (text: string) => {
    setDisplay(text);
    if (!text.trim()) {
      setLocalError(null);
      commit(emptyValue);
      return;
    }
    const minor = decimalToMinor(text, minorUnits);
    if (minor === null) {
      setLocalError(
        minorUnits === 0
          ? 'Enter a whole number (no decimals).'
          : `Enter a valid amount with up to ${minorUnits} decimal places.`,
      );
      commit(emptyValue);
      return;
    }
    setLocalError(null);
    commit(minor.toString());
  };

  const handleBlur = () => {
    if (!localError && typeof field.value === 'string' && /^\d+$/.test(field.value)) {
      setDisplay(minorToDecimalString(field.value, minorUnits));
    }
    field.onBlur();
  };

  const error = localError ?? fieldState.error?.message;
  const symbol = format ? unitSymbol(format) : '';
  const isPoints = format?.unit === 'POINTS';

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
      <InputGroup className="sm:max-w-64">
        <InputGroupInput
          id={id}
          name={field.name}
          ref={fieldRef}
          inputMode={minorUnits === 0 ? 'numeric' : 'decimal'}
          autoComplete="off"
          placeholder={placeholder ?? (minorUnits === 0 ? '0' : `0.${'0'.repeat(minorUnits)}`)}
          value={display}
          onChange={(event) => handleChange(event.target.value)}
          onBlur={handleBlur}
          disabled={field.disabled || !ready}
          className="tabular-nums"
          aria-invalid={error ? true : undefined}
          aria-required={required || undefined}
          aria-describedby={describedBy(id, Boolean(description), Boolean(error))}
        />
        {symbol ? (
          <InputGroupAddon align={isPoints ? 'inline-end' : 'inline-start'}>
            <InputGroupText>{symbol}</InputGroupText>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
    </FormItem>
  );
}
