'use client';

import type { ColumnDef } from '@tanstack/react-table';
import { Bot, ScrollText, X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useId, useMemo } from 'react';
import type { AuditLogListItemDto } from '@app/shared';

import { DataTable, useCursorList, useUrlTextFilters } from '@/components/app/data-table';
import { DateTime } from '@/components/app/date-time';
import { PageHeader } from '@/components/app/page-header';
import { EmptyState } from '@/components/app/states';
import { ToneBadge } from '@/components/app/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { AUDIT_PATH } from '../api';
import { auditActionLabel, KNOWN_RESOURCE_TYPES, resourceTypeLabel, shortId } from '../format';
import { auditKeys } from '../query-keys';
import { AuditDetailSheet } from './audit-detail-sheet';

/** URL-synced filters. Dates are `YYYY-MM-DD` in the viewer's time zone. */
const FILTER_KEYS = ['action', 'resourceType', 'resourceId', 'actorId', 'programId', 'from', 'to'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
type Filters = Partial<Record<FilterKey, string>>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TEXT_DEBOUNCE_MS = 350;

function readFilters(params: URLSearchParams): Filters {
  const filters: Filters = {};
  for (const key of FILTER_KEYS) {
    const value = params.get(key)?.trim();
    if (!value) continue;
    if ((key === 'from' || key === 'to') && !DATE_RE.test(value)) continue;
    filters[key] = value;
  }
  return filters;
}

/** Local calendar day → ISO instant (start of `from`, end of `to`). */
function toApiQuery(filters: Filters): Record<string, string | undefined> {
  const { from, to, ...rest } = filters;
  return {
    ...rest,
    from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
    to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
  };
}

const columns: ColumnDef<AuditLogListItemDto>[] = [
  {
    id: 'createdAt',
    header: 'When',
    enableHiding: false,
    cell: ({ row }) => <DateTime value={row.original.createdAt} />,
  },
  {
    id: 'actor',
    header: 'Actor',
    meta: { label: 'Actor' },
    cell: ({ row }) =>
      row.original.actor ? (
        <span className="font-medium">{row.original.actor.fullName}</span>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <Bot className="size-3.5" aria-hidden /> System
        </span>
      ),
  },
  {
    id: 'action',
    header: 'Action',
    enableHiding: false,
    cell: ({ row }) => (
      <div className="min-w-0">
        <span className="block font-medium">{auditActionLabel(row.original.action)}</span>
        <code className="block font-mono text-xs text-muted-foreground">{row.original.action}</code>
      </div>
    ),
  },
  {
    id: 'resource',
    header: 'Resource',
    meta: { label: 'Resource' },
    cell: ({ row }) => (
      <div className="min-w-0">
        <span className="block">{resourceTypeLabel(row.original.resourceType)}</span>
        <code className="block font-mono text-xs text-muted-foreground" title={row.original.resourceId ?? undefined}>
          {shortId(row.original.resourceId)}
        </code>
      </div>
    ),
  },
  {
    id: 'program',
    header: 'Program',
    meta: { label: 'Program' },
    cell: ({ row }) => row.original.program?.name ?? <span className="text-muted-foreground">—</span>,
  },
  {
    id: 'reason',
    header: 'Reason',
    meta: { label: 'Reason', cellClassName: 'max-w-64' },
    cell: ({ row }) =>
      row.original.reason ? (
        <span className="line-clamp-2 whitespace-normal" title={row.original.reason}>
          {row.original.reason}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
];

/** Audit log: filters (action prefix, resource, actor, program, dates), table, detail drawer. */
export function AuditPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useMemo(() => readFilters(new URLSearchParams(searchParams.toString())), [searchParams]);
  const entryId = searchParams.get('entry');
  const baseId = useId();
  const ids = {
    action: `${baseId}-action`,
    resourceType: `${baseId}-type`,
    resourceId: `${baseId}-rid`,
    from: `${baseId}-from`,
    to: `${baseId}-to`,
    types: `${baseId}-types`,
  };

  const replaceParams = (patch: Record<string, string | undefined | null>) => {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  // Free-text filters: debounced into the URL (only the edited key), re-synced when the URL changes
  // elsewhere (links with filters, back/forward, this route revived by <Activity>).
  const { text, setText, clear: clearText } = useUrlTextFilters(
    {
      action: filters.action ?? '',
      resourceType: filters.resourceType ?? '',
      resourceId: filters.resourceId ?? '',
    },
    replaceParams,
    TEXT_DEBOUNCE_MS,
  );

  const apiQuery = toApiQuery(filters);
  const list = useCursorList<AuditLogListItemDto>({
    queryKey: auditKeys.list({ ...filters }),
    path: AUDIT_PATH,
    query: apiQuery,
  });

  const hasFilters = Object.keys(filters).length > 0;
  const clearAll = () => {
    clearText();
    replaceParams(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])));
  };

  const toolbar = (
    <div className="grid w-full gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(5,minmax(0,1fr))_auto] lg:items-end">
      <div className="space-y-1.5">
        <Label htmlFor={ids.action} className="text-xs text-muted-foreground">
          Action starts with
        </Label>
        <Input
          id={ids.action}
          value={text.action}
          onChange={(e) => setText('action', e.target.value)}
          placeholder="e.g. member. or reward.approve"
          maxLength={96}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={ids.resourceType} className="text-xs text-muted-foreground">
          Resource type
        </Label>
        <Input
          id={ids.resourceType}
          value={text.resourceType}
          onChange={(e) => setText('resourceType', e.target.value)}
          placeholder="e.g. user"
          list={ids.types}
          maxLength={64}
        />
        <datalist id={ids.types}>
          {KNOWN_RESOURCE_TYPES.map((type) => (
            <option key={type} value={type} />
          ))}
        </datalist>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={ids.resourceId} className="text-xs text-muted-foreground">
          Resource id
        </Label>
        <Input
          id={ids.resourceId}
          value={text.resourceId}
          onChange={(e) => setText('resourceId', e.target.value)}
          placeholder="Exact id"
          maxLength={64}
          spellCheck={false}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={ids.from} className="text-xs text-muted-foreground">
          From
        </Label>
        <Input
          id={ids.from}
          type="date"
          value={filters.from ?? ''}
          max={filters.to}
          onChange={(e) => replaceParams({ from: e.target.value || undefined })}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={ids.to} className="text-xs text-muted-foreground">
          To
        </Label>
        <Input
          id={ids.to}
          type="date"
          value={filters.to ?? ''}
          min={filters.from}
          onChange={(e) => replaceParams({ to: e.target.value || undefined })}
        />
      </div>
      {hasFilters ? (
        <Button variant="ghost" onClick={clearAll}>
          Clear filters
        </Button>
      ) : null}
      {filters.actorId || filters.programId ? (
        <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-6">
          {filters.actorId ? (
            <FilterChip label={`Actor ${shortId(filters.actorId)}`} onRemove={() => replaceParams({ actorId: undefined })} />
          ) : null}
          {filters.programId ? (
            <FilterChip label={`Program ${shortId(filters.programId)}`} onRemove={() => replaceParams({ programId: undefined })} />
          ) : null}
        </div>
      ) : null}
    </div>
  );

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every administrative change with its actor, reason and the fields it changed. Entries can't be edited or deleted."
      />
      <DataTable
        columns={columns}
        data={list.rows}
        isLoading={list.isLoading}
        isFetching={list.isFetching}
        error={list.error}
        onRetry={list.refetch}
        pagination={list.pagination}
        toolbar={toolbar}
        enableColumnVisibility
        caption="Audit log entries, newest first"
        onRowClick={(row) => replaceParams({ entry: row.id })}
        rowLabel={(row) => `Open ${auditActionLabel(row.action)} details`}
        emptyState={
          <EmptyState
            variant="plain"
            size="sm"
            icon={ScrollText}
            title={hasFilters ? 'No entries match these filters' : 'No audit entries yet'}
            description={hasFilters ? 'Try a broader action prefix or date range.' : 'Administrative changes will be listed here.'}
          />
        }
        renderCard={(row) => (
          <div className="space-y-1.5">
            <div className="flex items-start justify-between gap-2">
              <span className="font-medium">{auditActionLabel(row.action)}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                <DateTime value={row.createdAt} style="short" />
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {row.actor?.fullName ?? 'System'} · {resourceTypeLabel(row.resourceType)}
              {row.program ? ` · ${row.program.name}` : ''}
            </p>
            {row.reason ? <p className="line-clamp-2 text-sm">{row.reason}</p> : null}
          </div>
        )}
      />
      <AuditDetailSheet entryId={entryId} onOpenChange={(open) => (open ? undefined : replaceParams({ entry: undefined }))} />
    </>
  );
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <ToneBadge tone="primary" className="h-7 gap-1 pr-1">
      {label}
      <Button variant="ghost" size="icon-xs" className="size-5" aria-label={`Remove filter: ${label}`} onClick={onRemove}>
        <X aria-hidden />
      </Button>
    </ToneBadge>
  );
}
