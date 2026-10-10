'use client';

import { Gift, X } from 'lucide-react';
import { RewardStatus, type MemberRewardDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { DataTable, useCursorList } from '@/components/app/data-table';
import { PageHeader } from '@/components/app/page-header';
import { EmptyState } from '@/components/app/states';
import { StatusBadge } from '@/components/app/status-badge';
import { Button } from '@/components/ui/button';
import { enumOptions } from '@/lib/enum-labels';

import { DateRangeFilter, FilterSelect } from '../../../finance/components/filters';
import { ExportCsvButton } from '../../../finance/components/export-button';
import { localDayRange, unitFormat } from '../../../finance/lib';
import { financeKeys } from '../../../finance/query-keys';
import { useUrlState } from '../../../finance/use-url-state';
import { useMyRewardFacets } from '../../api';
import { EarningsSummary } from '../earnings-summary';
import { MemberRewardSheet } from './member-reward-sheet';
import { formatCalendarDate, latestDecision, memberRewardColumns } from './member-reward-columns';
import { RewardStatusLegend } from './reward-status-legend';

const URL_KEYS = ['status', 'program', 'from', 'to', 'reward'] as const;

/** Member rewards: earnings summary, filters, history (table + mobile cards) and CSV export. */
export function MemberRewardsPage() {
  const [filters, setFilters] = useUrlState(URL_KEYS);
  const facets = useMyRewardFacets();
  const status = filters.status && (RewardStatus as readonly string[]).includes(filters.status) ? filters.status : undefined;
  const range = localDayRange(filters.from, filters.to);
  const query = { status, programId: filters.program, from: range.from, to: range.to };
  const list = useCursorList<MemberRewardDto>({
    queryKey: financeKeys.member.list(query),
    path: '/users/me/rewards',
    query,
  });
  const hasFilters = Boolean(status || filters.program || filters.from || filters.to);
  const selected = filters.reward ? list.rows.find((r) => r.id === filters.reward) : undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Rewards"
        description="Rewards recorded for you from qualifying sales of approved offerings, and what happened to each one."
        actions={<ExportCsvButton path="/users/me/rewards/export.csv" query={query} fallbackName="my-rewards.csv" />}
      />

      <EarningsSummary variant="card" />

      <section className="space-y-3" aria-labelledby="reward-history-heading">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="reward-history-heading" className="text-base font-semibold">
              Reward history
            </h2>
            <p className="text-sm text-muted-foreground">Newest first. Dates are shown in each program’s time zone.</p>
          </div>
        </div>

        <DataTable
          columns={memberRewardColumns}
          data={list.rows}
          isLoading={list.isLoading}
          isFetching={list.isFetching}
          error={list.error}
          onRetry={list.refetch}
          pagination={list.pagination}
          caption="Your rewards"
          onRowClick={(r) => setFilters({ reward: r.id })}
          rowLabel={(r) => `View reward from ${r.program.name}`}
          toolbar={
            <div className="flex w-full flex-col gap-2">
              <div className="flex w-full flex-wrap items-center gap-2">
                <FilterSelect
                  label="Status"
                  value={status}
                  allLabel="All statuses"
                  options={enumOptions('RewardStatus')}
                  onChange={(v) => setFilters({ status: v, reward: null })}
                />
                <FilterSelect
                  label="Program"
                  value={filters.program}
                  allLabel="All programs"
                  options={(facets.data?.programs ?? []).map((p) => ({ value: p.id, label: p.name }))}
                  onChange={(v) => setFilters({ program: v, reward: null })}
                  disabled={facets.isPending && !filters.program}
                  className="sm:w-52"
                />
                <DateRangeFilter
                  label="Date"
                  from={filters.from}
                  to={filters.to}
                  onChange={(patch) => setFilters({ ...patch, reward: null })}
                />
                {hasFilters ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setFilters({ status: null, program: null, from: null, to: null, reward: null })}
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
              title={hasFilters ? 'No rewards match these filters' : 'No rewards yet'}
              description={
                hasFilters
                  ? 'Try a different status, program or date range.'
                  : 'A reward is recorded when a qualifying sale of an approved offering is processed under a program you take part in.'
              }
            />
          }
          renderCard={(r) => <MemberRewardCard reward={r} />}
        />
      </section>

      <RewardStatusLegend />

      <MemberRewardSheet
        rewardId={filters.reward}
        initial={selected}
        onOpenChange={(open) => {
          if (!open) setFilters({ reward: null });
        }}
      />
    </div>
  );
}

function MemberRewardCard({ reward }: { reward: MemberRewardDto }) {
  const d = latestDecision(reward);
  const voided = reward.status === 'REJECTED' || reward.status === 'REVERSED';
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{reward.program.name}</p>
          <p className="text-xs text-muted-foreground">
            {formatCalendarDate(reward.createdDate)} · Level {reward.level}
          </p>
        </div>
        <Amount
          value={reward.amountMinor}
          format={unitFormat(reward)}
          tone={voided ? 'muted' : 'default'}
          className={voided ? 'line-through' : 'font-semibold'}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StatusBadge kind="RewardStatus" value={reward.status} />
        <span className="text-xs text-muted-foreground">
          {d ? `${d.label} ${formatCalendarDate(d.date)}` : 'Awaiting review'}
        </span>
      </div>
      {d?.reason ? <p className="line-clamp-2 text-xs text-muted-foreground">{d.reason}</p> : null}
    </div>
  );
}
