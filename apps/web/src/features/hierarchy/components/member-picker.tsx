'use client';

import { useQuery } from '@tanstack/react-query';
import { Loader2, Search, X } from 'lucide-react';
import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import type { AdminMemberListItemDto, UserStatus } from '@app/shared';

import { StatusBadge } from '@/components/app/status-badge';
import { UserAvatar } from '@/components/app/user-avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, getErrorMessage } from '@/lib/api-client';
import { cn } from '@/lib/utils';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PickedMember {
  id: string;
  fullName: string | null;
  email?: string;
  status?: UserStatus;
}

export interface MemberPickerProps {
  id?: string;
  value: PickedMember | null;
  onChange: (member: PickedMember | null) => void;
  /** Only offer members with this status (e.g. ACTIVE sponsors). */
  status?: UserStatus;
  /** Members that cannot be picked (e.g. the member being moved). */
  excludeIds?: readonly string[];
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  placeholder?: string;
}

/**
 * Admin member combobox: searches `GET /admin/members?q=` (name or email) and also accepts a pasted
 * member ID. Admin-only (members:read).
 */
export function MemberPicker({
  id,
  value,
  onChange,
  status,
  excludeIds = [],
  disabled,
  invalid,
  describedBy,
  placeholder = 'Search by name or email, or paste a member ID',
}: MemberPickerProps) {
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(text.trim()), 250);
    return () => clearTimeout(handle);
  }, [text]);

  const isId = UUID_RE.test(debounced);
  const enabled = debounced.length >= 2 && !isId && !value;
  const query = useQuery({
    queryKey: ['admin', 'members', 'picker', debounced, status ?? null],
    queryFn: ({ signal }) =>
      api.getPage<AdminMemberListItemDto>('/admin/members', { query: { q: debounced, status, limit: 8 }, signal }),
    enabled,
    staleTime: 30_000,
  });

  const options: PickedMember[] = isId
    ? [{ id: debounced.toLowerCase(), fullName: null }]
    : (query.data?.data ?? [])
        .filter((m) => !excludeIds.includes(m.id))
        .map((m) => ({ id: m.id, fullName: m.fullName, email: m.email, status: m.status }));
  const showList = open && !value && (isId || debounced.length >= 2);

  function pick(member: PickedMember) {
    onChange(member);
    setOpen(false);
    setText('');
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, Math.max(options.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      const option = options[active];
      if (showList && option) {
        event.preventDefault();
        pick(option);
      }
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  }

  if (value) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-input px-3 py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <UserAvatar name={value.fullName ?? '?'} size="sm" />
          <div className="min-w-0 text-sm">
            <p className="truncate font-medium">{value.fullName ?? 'Member by ID'}</p>
            <p className="truncate font-mono text-xs text-muted-foreground">{value.email ?? value.id}</p>
          </div>
          {value.status ? <StatusBadge kind="UserStatus" value={value.status} /> : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Change selected member"
          onClick={() => onChange(null)}
          disabled={disabled}
        >
          <X aria-hidden />
        </Button>
      </div>
    );
  }

  const activeId = showList && options[active] ? `${listId}-${active}` : undefined;
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input
        id={id}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        value={text}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        className="pl-8"
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
      />
      {showList ? (
        <div className="absolute top-full right-0 left-0 z-50 mt-1 overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10">
          <ul id={listId} role="listbox" aria-label="Members" className="max-h-64 overflow-y-auto py-1">
            {options.map((m, i) => (
              <li
                key={m.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={cn('flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm', i === active && 'bg-accent')}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(m)}
              >
                {m.fullName ? (
                  <>
                    <UserAvatar name={m.fullName} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{m.fullName}</span>
                      <span className="block truncate text-xs text-muted-foreground">{m.email}</span>
                    </span>
                  </>
                ) : (
                  <span className="font-mono text-xs">Use member ID {m.id}</span>
                )}
              </li>
            ))}
          </ul>
          {!isId ? (
            <div className="border-t px-3 py-2 text-xs text-muted-foreground" aria-live="polite">
              {query.isFetching || !enabled ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="size-3 animate-spin" aria-hidden /> Searching…
                </span>
              ) : query.error ? (
                getErrorMessage(query.error)
              ) : options.length === 0 ? (
                'No matching members.'
              ) : (
                `${options.length} match${options.length === 1 ? '' : 'es'}`
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
