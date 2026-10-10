'use client';

import { ChevronDown, TriangleAlert } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { formatBps, type DryRunResultDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { DateTime } from '@/components/app/date-time';
import { ToneBadge } from '@/components/app/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { enumLabel } from '@/lib/enum-labels';
import { cn } from '@/lib/utils';
import { useFormatAmount } from '@/providers/platform-settings-provider';

import { toBigIntOrZero, unitFormat } from '../format';
import { decisionMeta } from '../labels';
import { BudgetBar, BudgetLegendItem } from './budget-bar';

export interface DryRunResultViewProps {
  result: DryRunResultDto;
  pointsLabel: string;
  /** Program time zone. */
  timeZone: string;
  includesUnsavedChanges?: boolean;
}

/** Result of a dry run: summary, budget bar, allocations, per-level decisions, warnings, raw trace. */
export function DryRunResultView({
  result,
  pointsLabel,
  timeZone,
  includesUnsavedChanges,
}: DryRunResultViewProps) {
  const [traceOpen, setTraceOpen] = useState(false);
  const headingId = useId();
  const { formatAmount } = useFormatAmount();
  const rewardFmt = unitFormat(result.unit, pointsLabel);
  const currencyFmt = {
    currencyCode: result.unit.currencyCode,
    minorUnits: result.unit.currencyMinorUnits,
  };
  const isPoints = result.unit.rewardUnit === 'POINTS';
  const member = result.mode === 'MEMBER';

  const recipientLabel = (depth: number | null, displayName: string | null) =>
    member
      ? (displayName ?? (depth !== null ? `Member at depth ${depth}` : '—'))
      : depth !== null
        ? `Ancestor at depth ${depth}`
        : '—';

  return (
    <section aria-labelledby={headingId} className="space-y-5 border-t pt-5">
      <div className="space-y-1">
        <h4 id={headingId} className="font-heading text-sm font-semibold">
          Preview result
        </h4>
        <p className="text-xs text-muted-foreground">
          {enumLabel('QualifyingEventType', result.eventType)} of{' '}
          <Amount kind="currency" value={result.saleAmountMinor} format={currencyFmt} /> ·{' '}
          {member ? (
            <>
              real upline
              {result.occurredAt ? (
                <>
                  {' '}
                  at <DateTime value={result.occurredAt} timeZone={timeZone} showTimeZone />
                </>
              ) : null}
            </>
          ) : (
            `synthetic upline of ${result.ancestors.length}`
          )}
          {includesUnsavedChanges ? ' · includes unsaved changes' : ''} · engine{' '}
          <span className="font-mono">{result.engineVersion}</span>
        </p>
      </div>

      {!result.applicable ? (
        <Alert className="border-warning/30 bg-warning/5">
          <TriangleAlert aria-hidden className="text-warning" />
          <AlertTitle className="text-warning">This sale would be rejected</AlertTitle>
          <AlertDescription>
            {result.notApplicableReason ?? 'The sale does not qualify under this version.'} No
            rewards would be calculated.
          </AlertDescription>
        </Alert>
      ) : null}

      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Figure label="Sale amount">
          <Amount kind="currency" value={result.saleAmountMinor} format={currencyFmt} />
        </Figure>
        <Figure
          label={isPoints ? 'Reward base (points value)' : 'Reward base'}
          hint={
            isPoints
              ? `${result.unit.pointsPerCurrencyUnit.toLocaleString('en')} ${pointsLabel} per 1 ${result.unit.currencyCode}`
              : undefined
          }
        >
          <Amount value={result.baseMinor} format={rewardFmt} />
        </Figure>
        <Figure label="Budget" hint={`${formatBps(result.budgetBps)} of the sale`}>
          <Amount value={result.budgetMinor} format={rewardFmt} />
        </Figure>
        <Figure label="Hard cap" hint="50% of the sale — can never be exceeded">
          <Amount value={result.hardCapMinor} format={rewardFmt} />
        </Figure>
        <Figure label="Allocated">
          <Amount value={result.totalAllocatedMinor} format={rewardFmt} className="font-semibold" />
        </Figure>
        <Figure label="Unallocated budget">
          <Amount value={result.unallocatedMinor} format={rewardFmt} tone="muted" />
        </Figure>
      </dl>

      <BudgetBar
        allocated={toBigIntOrZero(result.totalAllocatedMinor)}
        budget={toBigIntOrZero(result.budgetMinor)}
        hardCap={toBigIntOrZero(result.hardCapMinor)}
        label={`Allocated ${formatAmount(result.totalAllocatedMinor, rewardFmt)} of a ${formatAmount(
          result.budgetMinor,
          rewardFmt,
        )} budget; hard cap ${formatAmount(result.hardCapMinor, rewardFmt)}`}
        legend={
          <>
            <BudgetLegendItem swatch="used">Allocated</BudgetLegendItem>
            <BudgetLegendItem swatch="remaining">Remaining budget</BudgetLegendItem>
            <BudgetLegendItem swatch="marker">
              Budget ({formatBps(result.budgetBps)})
            </BudgetLegendItem>
            <BudgetLegendItem swatch="cap">Up to the 50% hard cap</BudgetLegendItem>
          </>
        }
      />

      {result.warnings.length > 0 ? (
        <Alert className="border-warning/30 bg-warning/5">
          <TriangleAlert aria-hidden className="text-warning" />
          <AlertTitle className="text-warning">Warnings</AlertTitle>
          <AlertDescription>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {result.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-2">
        <h5 className="text-sm font-medium">Allocations</h5>
        {result.allocations.length > 0 ? (
          <Table>
            <TableCaption className="sr-only">Rewards each level would receive</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Level</TableHead>
                <TableHead>Depth</TableHead>
                <TableHead>Recipient</TableHead>
                <TableHead className="text-right">Rule amount</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.allocations.map((allocation) => (
                <TableRow key={`${allocation.level}-${allocation.depth}`}>
                  <TableCell className="font-medium">Level {allocation.level}</TableCell>
                  <TableCell className="tabular-nums">{allocation.depth}</TableCell>
                  <TableCell>{recipientLabel(allocation.depth, allocation.displayName)}</TableCell>
                  <TableCell className="text-right">
                    <Amount value={allocation.ruleAmountMinor} format={rewardFmt} tone="muted" />
                  </TableCell>
                  <TableCell className="text-right">
                    <Amount
                      value={allocation.amountMinor}
                      format={rewardFmt}
                      className="font-medium"
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {allocation.capped ? <ToneBadge tone="info">Capped</ToneBadge> : null}
                      {allocation.budgetLimited ? (
                        <ToneBadge tone="warning">Budget-limited</ToneBadge>
                      ) : null}
                      {!allocation.capped && !allocation.budgetLimited ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
            No level would receive a reward for this sale.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <h5 className="text-sm font-medium">Decision per level</h5>
        <ol className="divide-y rounded-lg border">
          {result.levels.map((level) => {
            const meta = decisionMeta(level.decision);
            return (
              <li
                key={level.level}
                className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">Level {level.level}</span>
                    <ToneBadge tone={meta.tone}>{meta.label}</ToneBadge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {level.depth !== null
                      ? recipientLabel(level.depth, level.displayName)
                      : 'No recipient'}
                    {level.calcType ? ` · ${ruleText(level)}` : ''}
                    {level.reason ? ` · ${level.reason}` : ''}
                  </p>
                </div>
                <div className="shrink-0 text-sm sm:text-right">
                  <Amount value={level.amountMinor} format={rewardFmt} fallback="—" />
                  {level.capped || level.budgetLimited ? (
                    <p className="text-xs text-muted-foreground">
                      {[
                        level.capped ? 'capped' : null,
                        level.budgetLimited ? 'budget-limited' : null,
                      ]
                        .filter(Boolean)
                        .join(', ')}
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      <Collapsible open={traceOpen} onOpenChange={setTraceOpen}>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="-ml-2">
            <ChevronDown
              aria-hidden
              className={cn('transition-transform', traceOpen && 'rotate-180')}
            />
            {traceOpen ? 'Hide calculation trace' : 'Show calculation trace'}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed">
            {JSON.stringify(result.trace, null, 2)}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

function ruleText(level: DryRunResultDto['levels'][number]): string {
  if (level.calcType === 'PERCENTAGE' && level.percentageBps !== null) {
    return `${formatBps(level.percentageBps)} rule`;
  }
  if (level.calcType === 'FIXED') return 'fixed-amount rule';
  return '';
}

function Figure({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="rounded-lg bg-muted/50 px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-base font-medium tabular-nums">{children}</dd>
      {hint ? <dd className="text-xs text-muted-foreground">{hint}</dd> : null}
    </div>
  );
}
