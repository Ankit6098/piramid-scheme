'use client';

import { useQuery } from '@tanstack/react-query';
import { Loader2, Search, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getErrorMessage } from '@/lib/api-client';
import { cn } from '@/lib/utils';

import { hierarchyKeys } from '../query-keys';
import type { AnySearchResult, HierarchySource } from '../types';

export interface TeamSearchProps {
  source: HierarchySource;
  onPick: (result: AnySearchResult) => void;
  className?: string;
}

/**
 * Accessible combobox searching names in the team (members: display names of their descendants
 * within 10 levels; admins: full names in the member's subtree). Picking a result focuses it in the
 * tree with its path highlighted.
 */
export function TeamSearch({ source, onPick, className }: TeamSearchProps) {
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(text.trim()), 250);
    return () => clearTimeout(handle);
  }, [text]);

  const enabled = debounced.length >= 2;
  const query = useQuery({
    queryKey: hierarchyKeys.search(source.key, debounced),
    queryFn: ({ signal }) => source.search(debounced, signal),
    enabled,
    staleTime: 30_000,
  });
  const results = enabled ? (query.data?.data ?? []) : [];
  const showList = open && text.trim().length >= 2;

  function pick(result: AnySearchResult) {
    onPick(result);
    setOpen(false);
    setText(result.fullName ?? result.displayName);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      const r = results[active];
      if (showList && r) {
        event.preventDefault();
        pick(r);
      }
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  }

  const activeId = showList && results[active] ? `${listId}-${results[active].id}` : undefined;

  return (
    <div className={cn('relative w-full sm:max-w-sm', className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-label={source.admin ? 'Search this team by name' : 'Search your team by name'}
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        placeholder={source.admin ? 'Search by name…' : 'Search by first name…'}
        value={text}
        maxLength={64}
        className="pr-8 pl-8"
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
      />
      {text ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="absolute top-1/2 right-1.5 -translate-y-1/2"
          aria-label="Clear search"
          onClick={() => {
            setText('');
            inputRef.current?.focus();
          }}
        >
          <X aria-hidden />
        </Button>
      ) : null}
      {showList ? (
        <div
          className="absolute top-full right-0 left-0 z-30 mt-1 overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10"
        >
          <ul id={listId} role="listbox" aria-label="Matching members" className="max-h-72 overflow-y-auto py-1">
            {results.map((r, i) => (
              <li
                key={r.id}
                id={`${listId}-${r.id}`}
                role="option"
                aria-selected={i === active}
                className={cn(
                  'flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm',
                  i === active && 'bg-accent',
                )}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(r)}
              >
                <span className="truncate">
                  {r.fullName ?? r.displayName}
                  {r.statusBucket === 'INACTIVE' ? <span className="ml-2 text-xs text-muted-foreground">Inactive</span> : null}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">Level {r.depth}</span>
              </li>
            ))}
          </ul>
          <div className="border-t px-3 py-2 text-xs text-muted-foreground" aria-live="polite">
            {!enabled || query.isFetching ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="size-3 animate-spin" aria-hidden /> Searching…
              </span>
            ) : query.error ? (
              getErrorMessage(query.error)
            ) : results.length === 0 ? (
              'No members match.'
            ) : (
              `${results.length}${query.data?.page.nextCursor ? '+' : ''} match${results.length === 1 ? '' : 'es'} · Enter to show in the tree`
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
