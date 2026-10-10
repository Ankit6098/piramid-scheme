'use client';

import { Search, X } from 'lucide-react';
import { useEffect, useEffectEvent, useId, useState } from 'react';
import type { SaleProgramOptionDto } from '@app/shared';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { enumLabel, enumOptions } from '@/lib/enum-labels';

import { programOptionLabel } from '../labels';
import { EVENT_PARAM, hasActiveFilters, type EventFilters, type EventParamPatch } from '../use-event-filters';

const ALL = 'all';
const SEARCH_DEBOUNCE_MS = 400;

interface FilterSelectProps {
  label: string;
  value: string | undefined;
  allLabel: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string | null) => void;
  disabled?: boolean;
  className?: string;
}

function FilterSelect({
  label,
  value,
  allLabel,
  options,
  onChange,
  disabled,
  className,
}: FilterSelectProps) {
  return (
    <Select
      value={value ?? ALL}
      onValueChange={(next) => onChange(next === ALL ? null : next)}
      disabled={disabled}
    >
      <SelectTrigger size="sm" aria-label={label} className={className ?? 'w-full sm:w-40'}>
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

/** Debounced search box synced with the `q` URL param. */
function SearchBox({ value, onChange }: { value: string; onChange: (value: string | null) => void }) {
  const [text, setText] = useState(value);
  // Follow external changes of the URL (reset, back/forward). "Adjust state during render" pattern.
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    if (text.trim() !== value) setText(value);
  }

  const commit = useEffectEvent((next: string) => onChange(next || null));
  useEffect(() => {
    const next = text.trim();
    if (next === value) return;
    const timer = setTimeout(() => commit(next), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, value]);

  return (
    <form
      role="search"
      className="w-full sm:w-64"
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
          placeholder="External id or customer ref"
          aria-label="Search by exact external id or customer reference"
          maxLength={128}
          autoComplete="off"
          spellCheck={false}
        />
      </InputGroup>
    </form>
  );
}

export interface EventFiltersToolbarProps {
  filters: EventFilters;
  programs: readonly SaleProgramOptionDto[] | undefined;
  programsLoading: boolean;
  /** Zone the date filters are interpreted in (shown as a hint). */
  timeZone: string;
  onChange: (patch: EventParamPatch) => void;
  onReset: () => void;
}

export function EventFiltersToolbar({
  filters,
  programs,
  programsLoading,
  timeZone,
  onChange,
  onReset,
}: EventFiltersToolbarProps) {
  const fromId = useId();
  const toId = useId();
  const hintId = useId();
  const programOptions = (programs ?? []).map((program) => ({
    value: program.id,
    label: programOptionLabel(program, enumLabel('ProgramStatus', program.status)),
  }));
  // Keep a program that is in the URL selectable even before/without the options list.
  if (filters.programId && !programOptions.some((o) => o.value === filters.programId)) {
    programOptions.unshift({
      value: filters.programId,
      label: programsLoading ? 'Loading…' : 'Unknown program',
    });
  }

  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex w-full flex-wrap items-center gap-2">
        <SearchBox
          value={filters.q ?? ''}
          onChange={(q) => onChange({ [EVENT_PARAM.q]: q })}
        />
        <FilterSelect
          label="Program"
          value={filters.programId}
          allLabel="All programs"
          options={programOptions}
          onChange={(program) => onChange({ [EVENT_PARAM.program]: program })}
          disabled={programsLoading && !filters.programId}
          className="w-full sm:w-52"
        />
        <FilterSelect
          label="Status"
          value={filters.status}
          allLabel="All statuses"
          options={enumOptions('QualifyingEventStatus')}
          onChange={(status) => onChange({ [EVENT_PARAM.status]: status })}
        />
        <FilterSelect
          label="Sale type"
          value={filters.type}
          allLabel="All sale types"
          options={enumOptions('QualifyingEventType')}
          onChange={(type) => onChange({ [EVENT_PARAM.type]: type })}
        />
        <FilterSelect
          label="Source"
          value={filters.source}
          allLabel="All sources"
          options={enumOptions('QualifyingEventSource')}
          onChange={(source) => onChange({ [EVENT_PARAM.source]: source })}
        />
      </div>
      <div className="flex w-full flex-wrap items-center gap-2">
        <div className="flex items-center gap-2">
          <label htmlFor={fromId} className="text-xs text-muted-foreground">
            Occurred from
          </label>
          <Input
            id={fromId}
            type="date"
            value={filters.from ?? ''}
            max={filters.to}
            onChange={(event) => onChange({ [EVENT_PARAM.from]: event.target.value || null })}
            aria-describedby={hintId}
            className="h-7 w-38 text-xs"
          />
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor={toId} className="text-xs text-muted-foreground">
            to
          </label>
          <Input
            id={toId}
            type="date"
            value={filters.to ?? ''}
            min={filters.from}
            onChange={(event) => onChange({ [EVENT_PARAM.to]: event.target.value || null })}
            aria-describedby={hintId}
            className="h-7 w-38 text-xs"
          />
        </div>
        <span id={hintId} className="text-xs text-muted-foreground">
          Dates in {timeZone}
        </span>
        {hasActiveFilters(filters) ? (
          <Button variant="ghost" size="sm" onClick={onReset} className="sm:ml-auto">
            <X aria-hidden />
            Reset filters
          </Button>
        ) : null}
      </div>
    </div>
  );
}
