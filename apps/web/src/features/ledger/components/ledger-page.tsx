'use client';

import { BookOpen, Landmark, Undo2, Wallet, X } from 'lucide-react';
import { useMemo } from 'react';
import { LedgerAccountType, LedgerTransactionType, Permission, type LedgerAccountDto, type LedgerTransactionDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { DataTable, useCursorList } from '@/components/app/data-table';
import { DateTime } from '@/components/app/date-time';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { EmptyState, StatGridSkeleton } from '@/components/app/states';
import { StatCard } from '@/components/app/stat-card';
import { StatusBadge } from '@/components/app/status-badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useSession } from '@/hooks/use-session';
import { enumOptions } from '@/lib/enum-labels';

import { ExportCsvButton } from '../../finance/components/export-button';
import { DateRangeFilter, FilterSelect } from '../../finance/components/filters';
import { localDayRange, unitFormat } from '../../finance/lib';
import { financeKeys } from '../../finance/query-keys';
import { useUrlState } from '../../finance/use-url-state';
import { useLedgerSummary } from '../api';
import { accountColumns, transactionColumns } from './ledger-columns';
import { LedgerTransactionSheet } from './ledger-transaction-sheet';

const URL_KEYS = ['view', 'type', 'from', 'to', 'member', 'reward', 'accountType', 'nonZero', 'txn'] as const;

/** Ledger: totals per unit/currency, transactions (with entry detail) and account balances. */
export function LedgerPage() {
  const { can } = useSession();
  const [f, setF] = useUrlState(URL_KEYS);
  const view = f.view === 'accounts' ? 'accounts' : 'transactions';
  const range = localDayRange(f.from, f.to);
  const txnQuery = {
    type: f.type && (LedgerTransactionType as readonly string[]).includes(f.type) ? f.type : undefined,
    from: range.from,
    to: range.to,
    memberId: f.member,
    rewardId: f.reward,
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ledger"
        description="Double-entry record of reward liabilities. Every posting debits platform reward expense and credits the member’s rewards payable; reversals mirror them. No payouts are made from this ledger."
        actions={
          can(Permission.ReportsExport) ? (
            <ExportCsvButton path="/admin/ledger/export.csv" query={txnQuery} fallbackName="ledger-entries.csv" />
          ) : null
        }
      />

      <LedgerSummary />

      <Tabs value={view} onValueChange={(v) => setF({ view: v === 'transactions' ? null : v, txn: null })}>
        <TabsList aria-label="Ledger view">
          <TabsTrigger value="transactions">
            <BookOpen aria-hidden />
            Transactions
          </TabsTrigger>
          <TabsTrigger value="accounts">
            <Wallet aria-hidden />
            Accounts & balances
          </TabsTrigger>
        </TabsList>
        <TabsContent value="transactions">
          <TransactionsTable query={txnQuery} filters={f} setFilters={setF} />
        </TabsContent>
        <TabsContent value="accounts">
          <AccountsTable filters={f} setFilters={setF} />
        </TabsContent>
      </Tabs>

      <LedgerTransactionSheet
        transactionId={f.txn}
        onOpenChange={(open) => {
          if (!open) setF({ txn: null });
        }}
        onOpenTransaction={(id) => setF({ txn: id })}
      />
    </div>
  );
}

function LedgerSummary() {
  const summary = useLedgerSummary();
  if (summary.isPending) return <StatGridSkeleton count={3} />;
  if (summary.error) return <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />;
  const buckets = summary.data.buckets;
  if (buckets.length === 0) {
    return (
      <EmptyState
        icon={Landmark}
        title="No ledger activity yet"
        description="Transactions appear here once rewards are approved and posted."
        size="sm"
      />
    );
  }
  return (
    <div className="space-y-4">
      {buckets.map((b) => {
        const fmt = unitFormat(b);
        return (
          <section key={`${b.rewardUnit}:${b.currencyCode}`} aria-label={`Totals in ${b.rewardUnit === 'POINTS' ? 'points' : b.currencyCode}`} className="space-y-2">
            {buckets.length > 1 ? (
              <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {b.rewardUnit === 'POINTS' ? 'Points' : b.currencyCode}
              </h2>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard
                label="Total posted"
                icon={BookOpen}
                value={<Amount value={b.postedMinor} format={fmt} />}
                hint={`${b.postedCount} ${b.postedCount === 1 ? 'posting' : 'postings'}`}
              />
              <StatCard
                label="Total reversed"
                icon={Undo2}
                value={<Amount value={b.reversedMinor} format={fmt} />}
                hint={`${b.reversedCount} ${b.reversedCount === 1 ? 'reversal' : 'reversals'}`}
              />
              <StatCard
                label="Outstanding liability"
                icon={Wallet}
                value={<Amount value={b.outstandingLiabilityMinor} format={fmt} />}
                hint={`Owed to members across ${b.memberAccounts} ${b.memberAccounts === 1 ? 'account' : 'accounts'} (recorded, not paid out)`}
              />
            </div>
          </section>
        );
      })}
    </div>
  );
}

type Filters = Record<(typeof URL_KEYS)[number], string | undefined>;
type SetFilters = (patch: Partial<Record<(typeof URL_KEYS)[number], string | null>>) => void;

function TransactionsTable({
  query,
  filters,
  setFilters,
}: {
  query: Record<string, string | undefined>;
  filters: Filters;
  setFilters: SetFilters;
}) {
  const list = useCursorList<LedgerTransactionDto>({
    queryKey: financeKeys.ledger.transactions(query),
    path: '/admin/ledger/transactions',
    query,
  });
  const columns = useMemo(() => transactionColumns((t) => setFilters({ txn: t.id })), [setFilters]);
  const hasFilters = Boolean(filters.type || filters.from || filters.to || filters.member || filters.reward);

  return (
    <DataTable
      columns={columns}
      data={list.rows}
      isLoading={list.isLoading}
      isFetching={list.isFetching}
      error={list.error}
      onRetry={list.refetch}
      pagination={list.pagination}
      enableColumnVisibility
      caption="Ledger transactions"
      onRowClick={(t) => setFilters({ txn: t.id })}
      rowLabel={(t) => `Open transaction for ${t.member.fullName}`}
      toolbar={
        <div className="flex w-full flex-wrap items-center gap-2">
          <FilterSelect
            label="Transaction type"
            value={query.type}
            allLabel="All types"
            options={enumOptions('LedgerTransactionType')}
            onChange={(v) => setFilters({ type: v })}
          />
          <DateRangeFilter label="Posted" from={filters.from} to={filters.to} onChange={(p) => setFilters(p)} />
          {filters.member ? <ActiveFilter label="Member filter" onClear={() => setFilters({ member: null })} /> : null}
          {filters.reward ? <ActiveFilter label="Reward filter" onClear={() => setFilters({ reward: null })} /> : null}
          {hasFilters ? (
            <Button variant="ghost" size="sm" onClick={() => setFilters({ type: null, from: null, to: null, member: null, reward: null })}>
              <X aria-hidden />
              Clear filters
            </Button>
          ) : null}
        </div>
      }
      emptyState={
        <EmptyState
          variant="plain"
          size="sm"
          icon={BookOpen}
          title={hasFilters ? 'No transactions match these filters' : 'No transactions yet'}
          description={hasFilters ? 'Adjust or clear the filters.' : 'Approving a reward writes its posting here.'}
        />
      }
      renderCard={(t) => (
        <div className="space-y-1.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate font-medium">{t.member.fullName}</p>
              <p className="truncate text-xs text-muted-foreground">
                {t.program.name} · L{t.reward.level}
              </p>
            </div>
            <Amount
              value={t.type === 'REWARD_REVERSAL' ? `-${t.amountMinor}` : t.amountMinor}
              format={unitFormat(t)}
              tone="auto"
              signed
              className="font-semibold"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <StatusBadge kind="LedgerTransactionType" value={t.type} />
            <DateTime value={t.postedAt} className="text-xs text-muted-foreground" />
          </div>
        </div>
      )}
    />
  );
}

function AccountsTable({ filters, setFilters }: { filters: Filters; setFilters: SetFilters }) {
  const query = {
    type: filters.accountType && (LedgerAccountType as readonly string[]).includes(filters.accountType) ? filters.accountType : undefined,
    nonZero: filters.nonZero === 'true' ? 'true' : undefined,
    memberId: filters.member,
  };
  const list = useCursorList<LedgerAccountDto>({
    queryKey: financeKeys.ledger.accounts(query),
    path: '/admin/ledger/accounts',
    query,
  });
  return (
    <DataTable
      columns={accountColumns}
      data={list.rows}
      isLoading={list.isLoading}
      isFetching={list.isFetching}
      error={list.error}
      onRetry={list.refetch}
      pagination={list.pagination}
      caption="Ledger accounts and balances"
      onRowClick={(a) => (a.owner ? setFilters({ view: null, member: a.owner.id }) : undefined)}
      rowLabel={(a) => (a.owner ? `Show transactions of ${a.owner.fullName}` : 'Platform account')}
      toolbar={
        <div className="flex w-full flex-wrap items-center gap-3">
          <FilterSelect
            label="Account type"
            value={query.type}
            allLabel="All accounts"
            options={enumOptions('LedgerAccountType')}
            onChange={(v) => setFilters({ accountType: v })}
            className="sm:w-56"
          />
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={query.nonZero === 'true'} onCheckedChange={(c) => setFilters({ nonZero: c ? 'true' : null })} />
            Non-zero balances only
          </label>
          {filters.member ? <ActiveFilter label="Member filter" onClear={() => setFilters({ member: null })} /> : null}
        </div>
      }
      emptyState={
        <EmptyState variant="plain" size="sm" icon={Wallet} title="No accounts" description="Accounts are created with the first posting in each unit and currency." />
      }
      renderCard={(a) => (
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-medium">{a.owner?.fullName ?? 'Platform'}</p>
            <p className="text-xs text-muted-foreground">
              {a.type === 'PLATFORM_REWARD_EXPENSE' ? 'Platform reward expense' : 'Member rewards payable'} ·{' '}
              {a.rewardUnit === 'POINTS' ? 'Points' : a.currencyCode}
            </p>
          </div>
          <Amount value={a.balanceMinor} format={unitFormat(a)} tone="auto" className="font-semibold" />
        </div>
      )}
    />
  );
}

function ActiveFilter({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex h-7 items-center gap-1 rounded-full border bg-muted/40 pr-1 pl-2.5 text-xs">
      {label}
      <Button variant="ghost" size="icon-xs" onClick={onClear} aria-label={`Remove ${label.toLowerCase()}`}>
        <X aria-hidden />
      </Button>
    </span>
  );
}
