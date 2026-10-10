'use client';

import type { ColumnDef } from '@tanstack/react-table';
import { CircleAlert, CircleCheck, ClipboardList, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import type {
  ReconciliationCheckDto,
  ReconciliationExceptionDto,
  ReconciliationReportDto,
  ReconciliationSeverity,
} from '@app/shared';

import { Amount } from '@/components/app/amount';
import { CopyButton } from '@/components/app/copy-button';
import { DataTable } from '@/components/app/data-table';
import { ErrorState } from '@/components/app/error-state';
import { PageHeader } from '@/components/app/page-header';
import { RelativeTime } from '@/components/app/date-time';
import { CardSkeleton, EmptyState, TableSkeleton } from '@/components/app/states';
import { ToneBadge } from '@/components/app/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { routes } from '@/config/routes';
import { getErrorMessage } from '@/lib/api-client';
import type { StatusTone } from '@/lib/enum-labels';
import { cn } from '@/lib/utils';

import { FilterSelect } from '../../finance/components/filters';
import { shortId, unitFormat } from '../../finance/lib';
import { useReconciliationReport, useRefreshReconciliation } from '../api';

const SEVERITY: Record<ReconciliationSeverity, { label: string; tone: StatusTone }> = {
  critical: { label: 'Critical', tone: 'destructive' },
  warning: { label: 'Warning', tone: 'warning' },
  review: { label: 'Review', tone: 'info' },
};

/** Reconciliation: health summary, every §11 check with explanations, and the exceptions found. */
export function ReconciliationPage() {
  const report = useReconciliationReport();
  const refresh = useRefreshReconciliation();
  const [refreshing, setRefreshing] = useState(false);

  async function runNow() {
    setRefreshing(true);
    try {
      const r = await refresh();
      toast.success(r.totalExceptions === 0 ? 'All checks passed' : `${r.totalExceptions} exception(s) found`);
    } catch (error) {
      toast.error('Could not run the checks', { description: getErrorMessage(error) });
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reconciliation"
        description="Continuous proof that rewards, the double-entry ledger and member balances agree. Most of these conditions are blocked by the database; any exception here needs attention."
        actions={
          <Button variant="outline" onClick={() => void runNow()} disabled={refreshing || report.isPending}>
            {refreshing ? <Spinner aria-hidden /> : <RefreshCw aria-hidden />}
            Run checks now
          </Button>
        }
      />
      {report.isPending ? (
        <div className="space-y-6">
          <CardSkeleton lines={2} />
          <TableSkeleton rows={8} />
        </div>
      ) : report.error ? (
        <ErrorState error={report.error} onRetry={() => void report.refetch()} />
      ) : (
        <ReportView report={report.data} />
      )}
    </div>
  );
}

function ReportView({ report }: { report: ReconciliationReportDto }) {
  const failing = report.checks.filter((c) => !c.passed);
  const critical = failing.filter((c) => c.severity !== 'review').reduce((s, c) => s + c.count, 0);
  const review = failing.filter((c) => c.severity === 'review').reduce((s, c) => s + c.count, 0);
  return (
    <>
      <Card className={cn(report.healthy ? 'ring-success/30' : 'ring-destructive/40')}>
        <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span
              className={cn(
                'flex size-10 shrink-0 items-center justify-center rounded-full',
                report.healthy ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive',
              )}
            >
              {report.healthy ? <ShieldCheck className="size-5" aria-hidden /> : <TriangleAlert className="size-5" aria-hidden />}
            </span>
            <div className="space-y-0.5">
              <p className="text-base font-semibold" role="status">
                {report.healthy
                  ? 'Rewards and ledger are consistent'
                  : `${critical} integrity ${critical === 1 ? 'exception' : 'exceptions'} need attention`}
              </p>
              <p className="text-sm text-muted-foreground">
                {report.checks.filter((c) => c.passed).length} of {report.checks.length} checks passed
                {review > 0 ? ` · ${review} ${review === 1 ? 'sale' : 'sales'} queued for compliance review` : ''}
              </p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Checked <RelativeTime value={report.generatedAt} /> · results are cached for about a minute
          </p>
        </CardContent>
      </Card>

      <section className="space-y-3" aria-labelledby="checks-heading">
        <h2 id="checks-heading" className="text-base font-semibold">
          Checks
        </h2>
        <ul className="grid gap-3 md:grid-cols-2">
          {report.checks.map((c) => (
            <CheckCard key={c.key} check={c} />
          ))}
        </ul>
      </section>

      <ExceptionsSection report={report} />

      {report.summary.buckets.length > 0 ? <TotalsSection report={report} /> : null}
    </>
  );
}

function CheckCard({ check }: { check: ReconciliationCheckDto }) {
  const sev = SEVERITY[check.severity];
  return (
    <li className={cn('space-y-2 rounded-xl border bg-card p-4', !check.passed && check.severity !== 'review' && 'border-destructive/40')}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          {check.passed ? (
            <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          ) : (
            <CircleAlert className={cn('mt-0.5 size-4 shrink-0', check.severity === 'review' ? 'text-info' : 'text-destructive')} aria-hidden />
          )}
          <h3 className="text-sm font-medium">{check.label}</h3>
        </div>
        {check.passed ? (
          <ToneBadge tone="success">Passed</ToneBadge>
        ) : (
          <ToneBadge tone={sev.tone}>
            {check.count} · {sev.label}
          </ToneBadge>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{check.description}</p>
      {!check.passed ? <p className="text-xs">{check.remedy}</p> : null}
    </li>
  );
}

function resourceLink(e: ReconciliationExceptionDto): string | null {
  switch (e.resourceType) {
    case 'reward':
      return `${routes.admin.rewards}?tab=ALL&reward=${encodeURIComponent(e.resourceId)}`;
    case 'ledger_transaction':
      return `${routes.admin.ledger}?txn=${encodeURIComponent(e.resourceId)}`;
    case 'qualifying_event':
      return `${routes.admin.events}?event=${encodeURIComponent(e.resourceId)}`;
    case 'ledger_account':
    case 'member': {
      const member = typeof e.details.memberId === 'string' ? e.details.memberId : null;
      return member ? `${routes.admin.ledger}?view=accounts&member=${encodeURIComponent(member)}` : null;
    }
    default:
      return null;
  }
}

const RESOURCE_LABEL: Record<ReconciliationExceptionDto['resourceType'], string> = {
  reward: 'Reward',
  ledger_transaction: 'Ledger transaction',
  ledger_account: 'Payable account',
  qualifying_event: 'Sale',
  member: 'Member',
};

function ExceptionsSection({ report }: { report: ReconciliationReportDto }) {
  const [check, setCheck] = useState<string | undefined>();
  const labels = useMemo(() => new Map(report.checks.map((c) => [c.key, c.label])), [report.checks]);
  const rows = check ? report.exceptions.filter((e) => e.check === check) : report.exceptions;
  const columns = useMemo<ColumnDef<ReconciliationExceptionDto>[]>(
    () => [
      {
        id: 'severity',
        header: 'Severity',
        cell: ({ row }) => <ToneBadge tone={SEVERITY[row.original.severity].tone}>{SEVERITY[row.original.severity].label}</ToneBadge>,
      },
      {
        id: 'check',
        header: 'Check',
        cell: ({ row }) => <span className="text-sm">{labels.get(row.original.check) ?? row.original.check}</span>,
      },
      {
        id: 'resource',
        header: 'Record',
        cell: ({ row }) => <ResourceCell e={row.original} />,
      },
      {
        id: 'summary',
        header: 'What is wrong',
        cell: ({ row }) => <p className="max-w-md text-sm whitespace-normal">{row.original.summary}</p>,
      },
    ],
    [labels],
  );

  return (
    <section className="space-y-3" aria-labelledby="exceptions-heading">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="exceptions-heading" className="text-base font-semibold">
            Exceptions
          </h2>
          <p className="text-sm text-muted-foreground">
            {report.totalExceptions === 0
              ? 'Nothing to investigate.'
              : `${report.totalExceptions} found${report.truncated ? ` (showing up to ${report.exceptionLimitPerCheck} per check)` : ''}.`}
          </p>
        </div>
      </div>
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(e, i) => `${e.check}:${e.resourceId}:${i}`}
        caption="Reconciliation exceptions"
        toolbar={
          report.exceptions.length > 0 ? (
            <FilterSelect
              label="Check"
              value={check}
              allLabel="All checks"
              options={report.checks.filter((c) => !c.passed).map((c) => ({ value: c.key, label: c.label }))}
              onChange={(v) => setCheck(v ?? undefined)}
              className="sm:w-72"
            />
          ) : undefined
        }
        emptyState={
          <EmptyState
            variant="plain"
            size="sm"
            icon={ClipboardList}
            title="No exceptions"
            description="Every reward matches its ledger postings and every balance adds up."
          />
        }
        renderCard={(e) => (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <ToneBadge tone={SEVERITY[e.severity].tone}>{SEVERITY[e.severity].label}</ToneBadge>
              <span className="text-xs text-muted-foreground">{labels.get(e.check)}</span>
            </div>
            <p className="text-sm">{e.summary}</p>
            <ResourceCell e={e} />
          </div>
        )}
      />
    </section>
  );
}

function ResourceCell({ e }: { e: ReconciliationExceptionDto }) {
  const href = resourceLink(e);
  return (
    <span className="inline-flex items-center gap-1 text-sm">
      <span className="text-muted-foreground">{RESOURCE_LABEL[e.resourceType]}</span>
      {href ? (
        <Link href={href} className="font-mono text-xs text-primary hover:underline" title={e.resourceId}>
          {shortId(e.resourceId)}
        </Link>
      ) : (
        <span className="font-mono text-xs" title={e.resourceId}>
          {shortId(e.resourceId)}
        </span>
      )}
      <CopyButton value={e.resourceId} label="record id" variant="ghost" size="icon-xs" />
    </span>
  );
}

function TotalsSection({ report }: { report: ReconciliationReportDto }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Rewards vs ledger totals</CardTitle>
        <CardDescription>Each pair should match exactly.</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <caption className="sr-only">Reward totals compared with ledger totals per unit and currency</caption>
          <TableHeader>
            <TableRow>
              <TableHead>Unit</TableHead>
              <TableHead className="text-right">Rewards posted</TableHead>
              <TableHead className="text-right">Ledger postings</TableHead>
              <TableHead className="text-right">Rewards reversed</TableHead>
              <TableHead className="text-right">Ledger reversals</TableHead>
              <TableHead className="text-right">Expected payable</TableHead>
              <TableHead className="text-right">Payable balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.summary.buckets.map((b) => {
              const fmt = unitFormat(b);
              const mismatch = (x: string, y: string) => (x !== y ? 'text-destructive font-semibold' : '');
              return (
                <TableRow key={`${b.rewardUnit}:${b.currencyCode}`}>
                  <TableCell>{b.rewardUnit === 'POINTS' ? 'Points' : b.currencyCode}</TableCell>
                  <TableCell className="text-right">
                    <Amount value={b.rewardsPostedMinor} format={fmt} />
                  </TableCell>
                  <TableCell className={cn('text-right', mismatch(b.rewardsPostedMinor, b.ledgerPostedMinor))}>
                    <Amount value={b.ledgerPostedMinor} format={fmt} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Amount value={b.rewardsReversedMinor} format={fmt} />
                  </TableCell>
                  <TableCell className={cn('text-right', mismatch(b.rewardsReversedMinor, b.ledgerReversedMinor))}>
                    <Amount value={b.ledgerReversedMinor} format={fmt} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Amount value={b.expectedPayableMinor} format={fmt} />
                  </TableCell>
                  <TableCell className={cn('text-right', mismatch(b.expectedPayableMinor, b.payableBalanceMinor))}>
                    <Amount value={b.payableBalanceMinor} format={fmt} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
