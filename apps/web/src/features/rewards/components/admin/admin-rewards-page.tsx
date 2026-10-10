'use client';

import { Gift, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Permission, type AdminRewardRowDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { DataTable, useCursorList } from '@/components/app/data-table';
import { DateTime } from '@/components/app/date-time';
import { PageHeader } from '@/components/app/page-header';
import { EmptyState } from '@/components/app/states';
import { StatusBadge } from '@/components/app/status-badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useSession } from '@/hooks/use-session';
import { createIdempotencyKey } from '@/lib/api-client';

import { ExportCsvButton } from '../../../finance/components/export-button';
import { DateRangeFilter, FilterSelect, SearchFilter } from '../../../finance/components/filters';
import { localDayRange, unitFormat } from '../../../finance/lib';
import { financeKeys } from '../../../finance/query-keys';
import { useUrlState } from '../../../finance/use-url-state';
import { useAdminRewardCounts, useAdminRewardFacets } from '../../api';
import { QUEUE_TABS } from '../../labels';
import { adminRewardColumns, isSelectable, type RewardPermissions } from './admin-reward-columns';
import { BulkApproveBar } from './bulk-approve';
import { RewardDecisionDialog, type RewardDecisionIntent, type RewardDecisionKind } from './reward-decision-dialog';
import { RewardDetailSheet } from './reward-detail-sheet';

/**
 * URL state. Deep links: `?status=` is an alias of `?tab=` (admin overview), `?recipientUserId=`
 * (member detail) and `?event=` (a sale) scope the queue to one member's or one sale's rewards.
 */
const URL_KEYS = ['tab', 'status', 'program', 'level', 'q', 'from', 'to', 'reward', 'recipientUserId', 'event'] as const;
type UrlKey = (typeof URL_KEYS)[number];
const LEVEL_OPTIONS = Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: `Level ${i + 1}` }));
type Tab = (typeof QUEUE_TABS)[number]['value'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isTab = (value: string | undefined): value is Tab => QUEUE_TABS.some((t) => t.value === value);
/** Malformed ids are ignored rather than sent to the API (which would answer 400). */
const uuidParam = (value: string | undefined) => (value && UUID_RE.test(value) ? value : undefined);
/** One member's or one sale's rewards open on "All"; the plain queue opens on "Pending approval". */
const defaultTabFor = (scoped: boolean): Tab => (scoped ? 'ALL' : 'PENDING_APPROVAL');

/** Admin approval queue: status tabs with counts, filters, bulk approve, decision dialogs, detail drawer. */
export function AdminRewardsPage() {
  const { can } = useSession();
  const perms: RewardPermissions = {
    approve: can(Permission.RewardsApprove),
    reverse: can(Permission.RewardsReverse),
    reverseEvent: can(Permission.EventsReverse),
  };
  const [filters, setFilters] = useUrlState(URL_KEYS);
  const recipientUserId = uuidParam(filters.recipientUserId);
  const eventId = uuidParam(filters.event);
  const defaultTab = defaultTabFor(Boolean(recipientUserId || eventId));
  const tab: Tab = isTab(filters.tab) ? filters.tab : isTab(filters.status) ? filters.status : defaultTab;
  const status = tab === 'ALL' ? undefined : tab;
  const range = localDayRange(filters.from, filters.to);
  const baseQuery = {
    programId: filters.program,
    level: filters.level,
    q: filters.q,
    from: range.from,
    to: range.to,
    recipientUserId,
    eventId,
  };
  // The approval queue is first-in, first-out; the other tabs show the newest first.
  const order = tab === 'PENDING_APPROVAL' ? 'asc' : 'desc';
  const query = { ...baseQuery, status, order };

  const counts = useAdminRewardCounts(baseQuery);
  const facets = useAdminRewardFacets();
  const list = useCursorList<AdminRewardRowDto>({
    queryKey: financeKeys.adminRewards.list(query),
    path: '/admin/rewards',
    query,
  });

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [intent, setIntent] = useState<RewardDecisionIntent | null>(null);

  const selectableRows = list.rows.filter((r) => isSelectable(r, perms));
  const selectedRows = list.rows.filter((r) => selected.has(r.id));
  const allSelected = selectableRows.length > 0 && selectableRows.every((r) => selected.has(r.id));
  const someSelected = selectableRows.some((r) => selected.has(r.id));
  const selectionEnabled = perms.approve && (tab === 'PENDING_APPROVAL' || tab === 'ALL');

  const decide = (reward: RewardDecisionIntent['reward'], kind: RewardDecisionKind) =>
    setIntent({ kind, reward, idempotencyKey: createIdempotencyKey() });

  const columns = useMemo(
    () =>
      adminRewardColumns({
        perms,
        selected,
        selectable: selectionEnabled,
        allSelected,
        someSelected,
        onToggle: (id, checked) =>
          setSelected((prev) => {
            const next = new Set(prev);
            if (checked) next.add(id);
            else next.delete(id);
            return next;
          }),
        onToggleAll: (checked) => setSelected(checked ? new Set(selectableRows.map((r) => r.id)) : new Set()),
        onOpen: (r) => setFilters({ reward: r.id }),
        onDecide: decide,
      }),
    // perms are derived from the session each render; the booleans are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [perms.approve, perms.reverse, perms.reverseEvent, selected, selectionEnabled, allSelected, someSelected, list.rows, setFilters],
  );

  const hasFilters = Boolean(filters.program || filters.level || filters.q || filters.from || filters.to || recipientUserId || eventId);
  const changeFilters = (patch: Partial<Record<UrlKey, string | null>>) => {
    setSelected(new Set());
    // Removing the member/sale scope changes the default tab: keep the tab the user is looking at.
    const scopedAfter = Boolean(
      ('recipientUserId' in patch ? patch.recipientUserId : recipientUserId) || ('event' in patch ? patch.event : eventId),
    );
    const pinTab = 'tab' in patch ? {} : { tab: tab === defaultTabFor(scopedAfter) ? null : tab, status: null };
    setFilters({ ...pinTab, ...patch });
  };
  // Names for the scope chips come from the (already filtered) rows; no extra request.
  const recipientName = recipientUserId ? list.rows.find((r) => r.recipient.id === recipientUserId)?.recipient.fullName : undefined;
  const eventLabel = eventId ? list.rows.find((r) => r.event.id === eventId)?.event.externalId : undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Rewards"
        description="Review rewards calculated from qualifying sales. Approving a reward posts it to the ledger in the same step."
        actions={
          can(Permission.ReportsExport) ? (
            <ExportCsvButton path="/admin/rewards/export.csv" query={{ ...baseQuery, status }} fallbackName="rewards.csv" />
          ) : null
        }
      />

      <Tabs value={tab} onValueChange={(v) => changeFilters({ tab: v === defaultTab ? null : v, status: null, reward: null })}>
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <TabsList aria-label="Reward status">
            {QUEUE_TABS.map((t) => {
              const n = counts.data ? (t.value === 'ALL' ? counts.data.total : counts.data.byStatus[t.value]) : undefined;
              return (
                <TabsTrigger key={t.value} value={t.value} className="px-2.5">
                  {t.label}
                  {n !== undefined ? (
                    <span
                      className={
                        t.value === 'PENDING_APPROVAL' && n > 0
                          ? 'rounded-full bg-warning/15 px-1.5 text-xs font-semibold text-warning tabular-nums'
                          : 'rounded-full bg-muted-foreground/10 px-1.5 text-xs tabular-nums'
                      }
                    >
                      {n}
                    </span>
                  ) : null}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </div>

        <TabsContent value={tab} className="space-y-3">
          {tab === 'PENDING_APPROVAL' ? (
            <p className="text-xs text-muted-foreground">Oldest first. Rewards credited to you or from sales you recorded must be decided by another reviewer.</p>
          ) : null}
          <DataTable
            columns={columns}
            data={list.rows}
            isLoading={list.isLoading}
            isFetching={list.isFetching}
            error={list.error}
            onRetry={list.refetch}
            pagination={list.pagination}
            enableColumnVisibility
            caption="Rewards"
            onRowClick={(r) => setFilters({ reward: r.id })}
            rowLabel={(r) => `Open reward for ${r.recipient.fullName}`}
            toolbar={
              <div className="flex w-full flex-col gap-2">
                <div className="flex w-full flex-wrap items-center gap-2">
                  <SearchFilter
                    value={filters.q}
                    onChange={(q) => changeFilters({ q, reward: null })}
                    placeholder="Recipient name or email"
                    label="Search rewards by recipient name or email"
                  />
                  <FilterSelect
                    label="Program"
                    value={filters.program}
                    allLabel="All programs"
                    options={(facets.data?.programs ?? []).map((p) => ({ value: p.id, label: p.name }))}
                    onChange={(v) => changeFilters({ program: v, reward: null })}
                    disabled={facets.isPending && !filters.program}
                    className="sm:w-52"
                  />
                  <FilterSelect
                    label="Level"
                    value={filters.level}
                    allLabel="All levels"
                    options={LEVEL_OPTIONS}
                    onChange={(v) => changeFilters({ level: v, reward: null })}
                    className="sm:w-32"
                  />
                </div>
                <div className="flex w-full flex-wrap items-center gap-2">
                  <DateRangeFilter label="Created" from={filters.from} to={filters.to} onChange={(p) => changeFilters({ ...p, reward: null })} />
                  {recipientUserId ? (
                    <ScopeChip
                      label="Recipient"
                      value={recipientName ?? 'Selected member'}
                      onClear={() => changeFilters({ recipientUserId: null, reward: null })}
                    />
                  ) : null}
                  {eventId ? (
                    <ScopeChip label="Sale" value={eventLabel ?? 'Selected sale'} onClear={() => changeFilters({ event: null, reward: null })} />
                  ) : null}
                  {hasFilters ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        changeFilters({
                          program: null,
                          level: null,
                          q: null,
                          from: null,
                          to: null,
                          recipientUserId: null,
                          event: null,
                          reward: null,
                        })
                      }
                    >
                      <X aria-hidden />
                      Clear filters
                    </Button>
                  ) : null}
                </div>
              </div>
            }
            emptyState={
              <EmptyState
                variant="plain"
                size="sm"
                icon={Gift}
                title={tab === 'PENDING_APPROVAL' && !hasFilters ? 'Nothing waiting for approval' : 'No rewards found'}
                description={
                  tab === 'PENDING_APPROVAL' && !hasFilters
                    ? 'New rewards appear here when qualifying sales are processed.'
                    : 'Try another status tab or adjust the filters.'
                }
              />
            }
            renderCard={(r) => (
              <AdminRewardCard
                reward={r}
                selectable={selectionEnabled && isSelectable(r, perms)}
                selected={selected.has(r.id)}
                onToggle={(checked) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (checked) next.add(r.id);
                    else next.delete(r.id);
                    return next;
                  })
                }
              />
            )}
          />
        </TabsContent>
      </Tabs>

      <BulkApproveBar
        selected={selectedRows}
        onClear={() => setSelected(new Set())}
        onDone={(ids) =>
          setSelected((prev) => {
            const next = new Set(prev);
            for (const id of ids) next.delete(id);
            return next;
          })
        }
      />

      <RewardDetailSheet
        rewardId={filters.reward}
        perms={perms}
        onOpenChange={(open) => {
          if (!open) setFilters({ reward: null });
        }}
        onDecide={decide}
      />

      <RewardDecisionDialog
        intent={intent}
        onClose={() => setIntent(null)}
        onDone={() => {
          setIntent(null);
          if (intent) {
            setSelected((prev) => {
              const next = new Set(prev);
              next.delete(intent.reward.id);
              return next;
            });
          }
        }}
      />
    </div>
  );
}

/** An active deep-link scope (one member or one sale) with a button to remove it. */
function ScopeChip({ label, value, onClear }: { label: string; value: string; onClear: () => void }) {
  return (
    <span className="inline-flex h-7 max-w-full items-center gap-1 rounded-full border bg-muted/50 pr-0.5 pl-2.5 text-xs">
      <span className="text-muted-foreground">{label}:</span>
      <span className="truncate font-medium">{value}</span>
      <Button variant="ghost" size="icon-xs" className="rounded-full" onClick={onClear} aria-label={`Remove ${label.toLowerCase()} filter`}>
        <X aria-hidden />
      </Button>
    </span>
  );
}

function AdminRewardCard({
  reward,
  selectable,
  selected,
  onToggle,
}: {
  reward: AdminRewardRowDto;
  selectable: boolean;
  selected: boolean;
  onToggle: (checked: boolean) => void;
}) {
  return (
    <div className="flex gap-3">
      {selectable ? (
        <Checkbox
          checked={selected}
          onCheckedChange={(v) => onToggle(v === true)}
          aria-label={`Select reward for ${reward.recipient.fullName}`}
          className="mt-1"
        />
      ) : null}
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-medium">{reward.recipient.fullName}</p>
            <p className="truncate text-xs text-muted-foreground">
              {reward.program.name} · L{reward.level} · sale {reward.event.externalId}
            </p>
          </div>
          <Amount value={reward.amountMinor} format={unitFormat(reward)} className="font-semibold" />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <StatusBadge kind="RewardStatus" value={reward.status} />
          <DateTime value={reward.createdAt} className="text-xs text-muted-foreground" />
        </div>
      </div>
    </div>
  );
}
