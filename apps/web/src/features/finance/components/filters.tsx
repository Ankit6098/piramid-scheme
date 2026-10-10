'use client';

import { Search } from 'lucide-react';
import { useEffect, useEffectEvent, useId, useState } from 'react';

import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

const ALL = '__all__';

export interface FilterSelectProps {
  label: string;
  value: string | undefined;
  allLabel: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string | null) => void;
  disabled?: boolean;
  className?: string;
}

/** Compact select for table toolbars; "all" clears the filter. */
export function FilterSelect({ label, value, allLabel, options, onChange, disabled, className }: FilterSelectProps) {
  return (
    <Select value={value ?? ALL} onValueChange={(next) => onChange(next === ALL ? null : next)} disabled={disabled}>
      <SelectTrigger size="sm" aria-label={label} className={cn('w-full sm:w-44', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper">
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export interface DateRangeFilterProps {
  label: string;
  from: string | undefined;
  to: string | undefined;
  onChange: (patch: { from?: string | null; to?: string | null }) => void;
}

/** Two native date inputs (`YYYY-MM-DD`), interpreted as whole days in the viewer's time zone. */
export function DateRangeFilter({ label, from, to, onChange }: DateRangeFilterProps) {
  const fromId = useId();
  const toId = useId();
  return (
    <fieldset className="flex flex-wrap items-center gap-2">
      <legend className="sr-only">{label}</legend>
      <label htmlFor={fromId} className="text-xs text-muted-foreground">
        {label} from
      </label>
      <Input
        id={fromId}
        type="date"
        value={from ?? ''}
        max={to}
        onChange={(event) => onChange({ from: event.target.value || null })}
        className="h-7 w-38 text-xs"
      />
      <label htmlFor={toId} className="text-xs text-muted-foreground">
        to
      </label>
      <Input
        id={toId}
        type="date"
        value={to ?? ''}
        min={from}
        onChange={(event) => onChange({ to: event.target.value || null })}
        className="h-7 w-38 text-xs"
      />
    </fieldset>
  );
}

export interface SearchFilterProps {
  value: string | undefined;
  onChange: (value: string | null) => void;
  placeholder: string;
  label: string;
  className?: string;
}

/** Debounced search box (commits after 400 ms or on Enter). */
export function SearchFilter({ value = '', onChange, placeholder, label, className }: SearchFilterProps) {
  const [text, setText] = useState(value);
  // Follow external changes (reset, back/forward) — "adjust state during render".
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    if (text.trim() !== value) setText(value);
  }
  const commit = useEffectEvent((next: string) => onChange(next || null));
  useEffect(() => {
    const next = text.trim();
    if (next === value) return;
    const timer = setTimeout(() => commit(next), 400);
    return () => clearTimeout(timer);
  }, [text, value]);

  return (
    <form
      role="search"
      className={cn('w-full sm:w-60', className)}
      onSubmit={(event) => {
        event.preventDefault();
        onChange(text.trim() || null);
      }}
    >
      <InputGroup className="h-7">
        <InputGroupAddon>
          <Search aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={placeholder}
          aria-label={label}
          maxLength={100}
          autoComplete="off"
          spellCheck={false}
        />
      </InputGroup>
    </form>
  );
}
