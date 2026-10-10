'use client';

import { Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const ALL = '__all__';

export interface FilterSelectProps {
  /** Accessible name of the select. */
  label: string;
  value: string | undefined;
  allLabel: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string | undefined) => void;
  className?: string;
}

/** Compact single-choice filter with an "All …" entry (catalog list toolbars). */
export function FilterSelect({ label, value, allLabel, options, onChange, className }: FilterSelectProps) {
  return (
    <Select value={value ?? ALL} onValueChange={(next) => onChange(next === ALL ? undefined : next)}>
      <SelectTrigger size="sm" aria-label={label} className={className ?? 'w-full sm:w-44'}>
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

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label?: string;
  /** Debounce before `onChange` fires (ms). */
  delay?: number;
  className?: string;
}

/** Debounced search box with a clear button. */
export function SearchInput({ value, onChange, placeholder, label, delay = 350, className }: SearchInputProps) {
  const [text, setText] = useState(value);
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  }, [onChange]);
  // Follow external resets (e.g. "Reset filters").
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    setText(value);
  }
  useEffect(() => {
    if (text.trim() === value) return;
    const timer = window.setTimeout(() => latest.current(text.trim()), delay);
    return () => window.clearTimeout(timer);
  }, [text, value, delay]);

  return (
    <InputGroup className={className ?? 'w-full sm:w-64'}>
      <InputGroupAddon>
        <Search aria-hidden />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        maxLength={100}
      />
      {text ? (
        <InputGroupAddon align="inline-end">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Clear search"
            onClick={() => {
              setText('');
              onChange('');
            }}
          >
            <X aria-hidden />
          </Button>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
}
