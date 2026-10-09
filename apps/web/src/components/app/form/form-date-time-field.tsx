'use client';

import { Globe } from 'lucide-react';
import { useId } from 'react';
import { useController, type FieldPath, type FieldValues } from 'react-hook-form';

import { Input } from '@/components/ui/input';
import { useBrowserTimeZone } from '@/hooks/use-time-zone';
import { isoToLocalInput, localInputToIso, timeZoneLabel } from '@/lib/datetime';

import { describedBy, FormItem, type BaseFormFieldProps } from './form-item';

export interface FormDateTimeFieldProps<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
  TTransformed = TFieldValues,
> extends BaseFormFieldProps<TFieldValues, TName, TTransformed> {
  /**
   * IANA zone the user enters the time in (e.g. the program's `timezone`). Defaults to the
   * viewer's zone. The form value is always a UTC ISO string ("2026-10-10T09:00:00.000Z").
   */
  timeZone?: string;
  /** Earliest / latest allowed moment (UTC ISO). */
  min?: string;
  max?: string;
  /** Value stored when the input is cleared (default `""`; use `null` for nullable API fields). */
  emptyValue?: '' | null;
}

/**
 * Native `datetime-local` input with an explicit time-zone hint. Converts between the zone the
 * admin thinks in and the UTC ISO strings the API stores.
 */
export function FormDateTimeField<
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
  timeZone,
  min,
  max,
  emptyValue = '',
}: FormDateTimeFieldProps<TFieldValues, TName, TTransformed>) {
  const {
    field: { ref: fieldRef, ...field },
    fieldState,
  } = useController({ control, name, disabled });
  const browserZone = useBrowserTimeZone();
  const zone = timeZone ?? browserZone ?? 'UTC';
  const id = useId();
  const error = fieldState.error?.message;
  const iso = typeof field.value === 'string' ? field.value : null;

  const zoneHint = (
    <span className="inline-flex items-center gap-1">
      <Globe className="size-3.5" aria-hidden />
      Times are in {zone} ({timeZoneLabel(zone, iso ?? 0)})
    </span>
  );

  return (
    <FormItem
      id={id}
      label={label}
      description={
        description ? (
          <>
            {description}
            <br />
            {zoneHint}
          </>
        ) : (
          zoneHint
        )
      }
      error={error}
      required={required}
      disabled={field.disabled}
      hideLabel={hideLabel}
      className={className}
    >
      <Input
        id={id}
        type="datetime-local"
        name={field.name}
        ref={fieldRef}
        value={isoToLocalInput(iso, zone)}
        min={min ? isoToLocalInput(min, zone) : undefined}
        max={max ? isoToLocalInput(max, zone) : undefined}
        onChange={(event) => {
          const next = event.target.value;
          field.onChange(next ? (localInputToIso(next, zone) ?? emptyValue) : emptyValue);
        }}
        onBlur={field.onBlur}
        disabled={field.disabled}
        className="w-full sm:w-64"
        aria-invalid={error ? true : undefined}
        aria-required={required || undefined}
        aria-describedby={describedBy(id, true, Boolean(error))}
      />
    </FormItem>
  );
}
