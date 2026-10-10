'use client';

import { ChevronDown, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  formatBps,
  type CalcTraceStepDto,
  type SaleCalculationAncestorDto,
  type SaleEventCalculationDto,
} from '@app/shared';

import { Amount } from '@/components/app/amount';
import { CopyButton } from '@/components/app/copy-button';
import { DateTime } from '@/components/app/date-time';
import { ToneBadge } from '@/components/app/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import type { AmountFormatOverride } from '@/providers/platform-settings-provider';

import { decisionMeta, outcomeMeta } from '../labels';
import { DetailSection } from './detail-section';

type LevelStep = Extract<CalcTraceStepDto, { step: 'level' }>;

const MINOR_RE = /^-?\d+$/;

function minor(value: unknown): string | null {
  return typeof value === 'string' && MINOR_RE.test(value) ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

interface CalcContext {
  rewardFormat: AmountFormatOverride;
  saleFormat: AmountFormatOverride;
  names: ReadonlyMap<string, string>;
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5 rounded-lg border bg-muted/30 px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium tabular-nums">{children}</dd>
    </div>
  );
}

function AncestorsTable({ ancestors }: { ancestors: readonly SaleCalculationAncestorDto[] }) {
  if (ancestors.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        The member had no upline at the sale date, so nobody could receive a reward.
      </p>
    );
  }
  return (
    <div className="rounded-lg border">
      <Table>
        <caption className="sr-only">Upline members considered by the reward engine</caption>
        <TableHeader className="bg-muted/40">
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-16 px-3 text-xs">Depth</TableHead>
            <TableHead className="px-3 text-xs">Member</TableHead>
            <TableHead className="px-3 text-xs">Eligibility</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ancestors.map((ancestor) => (
            <TableRow key={`${ancestor.depth}-${ancestor.userId}`}>
              <TableCell className="px-3 tabular-nums">{ancestor.depth}</TableCell>
              <TableCell className="px-3">
                {ancestor.fullName ?? <span className="text-muted-foreground">Unknown member</span>}
              </TableCell>
              <TableCell className="px-3 whitespace-normal">
                <span className="flex flex-col gap-0.5">
                  <ToneBadge tone={ancestor.eligible ? 'success' : 'destructive-outline'}>
                    {ancestor.eligible ? 'Eligible' : 'Not eligible'}
                  </ToneBadge>
                  {!ancestor.eligible && ancestor.reason ? (
                    <span className="text-xs text-muted-foreground">{ancestor.reason}</span>
                  ) : null}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function LevelExplanation({ step, ctx }: { step: LevelStep; ctx: CalcContext }) {
  const d = step.detail;
  const reason = text(d.reason);
  switch (step.decision) {
    case 'AWARDED': {
      const percentageBps = int(d.percentageBps);
      const fixed = minor(d.fixedAmountMinor);
      const cap = minor(d.capMinor);
      const ruleAmount = minor(d.ruleAmountMinor);
      const remaining = minor(d.remainingBudgetMinor);
      return (
        <>
          {d.calcType === 'FIXED' && fixed ? (
            <>
              Fixed amount <Amount value={fixed} format={ctx.rewardFormat} />
            </>
          ) : percentageBps !== null ? (
            <>{formatBps(percentageBps)} of the base</>
          ) : (
            'Rule amount'
          )}
          {d.capped === true && cap ? (
            <>
              , capped at <Amount value={cap} format={ctx.rewardFormat} />
            </>
          ) : null}
          {d.budgetLimited === true && ruleAmount ? (
            <>
              ; reduced from <Amount value={ruleAmount} format={ctx.rewardFormat} /> to fit the
              remaining budget
            </>
          ) : null}
          {remaining ? (
            <>
              . Budget left: <Amount value={remaining} format={ctx.rewardFormat} />
            </>
          ) : null}
          .
        </>
      );
    }
    case 'NO_RULE':
      return <>The policy has no rule for level {step.level}.</>;
    case 'NO_ANCESTOR':
      return <>No upline member fills this level — the calculation stopped here.</>;
    case 'INELIGIBLE_FORFEITED':
      return (
        <>
          Not eligible at the sale date{reason ? ` (${reason})` : ''}; the level was forfeited.
        </>
      );
    case 'BUDGET_EXHAUSTED': {
      const ruleAmount = minor(d.ruleAmountMinor);
      return (
        <>
          {ruleAmount ? (
            <>
              The rule allowed <Amount value={ruleAmount} format={ctx.rewardFormat} />, but the
              budget was already used up.
            </>
          ) : (
            'The budget was already used up.'
          )}
        </>
      );
    }
    case 'ZERO_AMOUNT':
      return <>The rule produced no amount{reason ? ` (${reason})` : ''}.</>;
    default:
      return reason ? <>{reason}</> : null;
  }
}

function TraceStepItem({ step, ctx }: { step: CalcTraceStepDto; ctx: CalcContext }) {
  if (step.step === 'base') {
    return (
      <li className="flex gap-3 py-2.5">
        <span className="w-16 shrink-0 text-xs font-medium text-muted-foreground">Base</span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <p>
            Sale <Amount kind="currency" value={step.saleAmountMinor} format={ctx.saleFormat} /> →
            base <Amount value={step.baseMinor} format={ctx.rewardFormat} className="font-medium" />
          </p>
          <p className="text-xs text-muted-foreground">{step.note}</p>
        </div>
      </li>
    );
  }
  if (step.step === 'budget') {
    return (
      <li className="flex gap-3 py-2.5">
        <span className="w-16 shrink-0 text-xs font-medium text-muted-foreground">Budget</span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <p>
            {formatBps(step.budgetBps)} of the base ={' '}
            <Amount value={step.budgetMinor} format={ctx.rewardFormat} className="font-medium" />
          </p>
          {step.maxTotalPerEventMinor ? (
            <p className="text-xs text-muted-foreground">
              Limited to at most{' '}
              <Amount value={step.maxTotalPerEventMinor} format={ctx.rewardFormat} /> per sale by
              the policy.
            </p>
          ) : null}
        </div>
      </li>
    );
  }

  const meta = decisionMeta(step.decision);
  const userId = text(step.detail.userId);
  const depth = int(step.detail.depth);
  const name = userId ? (ctx.names.get(userId) ?? 'Unknown member') : null;
  const amount = step.decision === 'AWARDED' ? minor(step.detail.amountMinor) : null;

  return (
    <li className="flex gap-3 py-2.5">
      <span className="w-16 shrink-0 text-xs font-medium text-muted-foreground">
        Level {step.level}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <ToneBadge tone={meta.tone} title={meta.description}>
            {meta.label}
          </ToneBadge>
          {name ? (
            <span className="min-w-0 truncate">
              {name}
              {depth !== null ? (
                <span className="text-muted-foreground"> · depth {depth}</span>
              ) : null}
            </span>
          ) : null}
          {amount ? (
            <Amount value={amount} format={ctx.rewardFormat} className="ml-auto font-medium" />
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          <LevelExplanation step={step} ctx={ctx} />
        </p>
      </div>
    </li>
  );
}

export function EventCalculation({
  calculation,
  saleCurrencyCode,
  timeZone,
}: {
  calculation: SaleEventCalculationDto;
  saleCurrencyCode: string;
  timeZone: string;
}) {
  const [rawOpen, setRawOpen] = useState(false);
  const rewardFormat: AmountFormatOverride = {
    unit: calculation.rewardUnit,
    currencyCode: calculation.currencyCode,
    minorUnits: calculation.currencyMinorUnits,
  };
  const saleFormat: AmountFormatOverride = {
    currencyCode: saleCurrencyCode,
    minorUnits: calculation.currencyMinorUnits,
  };
  const names = new Map<string, string>();
  for (const ancestor of calculation.ancestors) {
    if (ancestor.fullName) names.set(ancestor.userId, ancestor.fullName);
  }
  const ctx: CalcContext = { rewardFormat, saleFormat, names };
  const outcome = outcomeMeta(calculation.outcome);
  const rawTrace = JSON.stringify(calculation.steps, null, 2);

  return (
    <DetailSection
      title="Calculation"
      description={
        <>
          Engine {calculation.engineVersion} ·{' '}
          <DateTime value={calculation.createdAt} timeZone={timeZone} />
        </>
      }
      actions={<ToneBadge tone={outcome.tone}>{outcome.label}</ToneBadge>}
    >
      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Stat label="Base">
          <Amount value={calculation.baseMinor} format={rewardFormat} />
        </Stat>
        <Stat label={`Budget (${formatBps(calculation.budgetBps)})`}>
          <Amount value={calculation.budgetMinor} format={rewardFormat} />
        </Stat>
        <Stat label="Allocated">
          <Amount value={calculation.totalAllocatedMinor} format={rewardFormat} />
        </Stat>
      </dl>
      {calculation.rewardUnit === 'POINTS' ? (
        <p className="text-xs text-muted-foreground">
          Converted at {calculation.pointsPerCurrencyUnit} points per 1 {calculation.currencyCode}.
        </p>
      ) : null}

      {calculation.warnings.length > 0 ? (
        <Alert role="note" className="border-warning/40 bg-warning/5 text-warning">
          <TriangleAlert aria-hidden />
          <AlertTitle>Calculation warnings</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-0.5 pl-4">
              {calculation.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Upline considered</h4>
        <AncestorsTable ancestors={calculation.ancestors} />
      </div>

      <div className="space-y-1">
        <h4 className="text-sm font-medium">Steps</h4>
        <ol className="divide-y rounded-lg border px-3 text-sm">
          {calculation.steps.map((step, index) => (
            <TraceStepItem key={`${step.step}-${index}`} step={step} ctx={ctx} />
          ))}
        </ol>
      </div>

      <Collapsible open={rawOpen} onOpenChange={setRawOpen}>
        <div className="flex items-center justify-between gap-2">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="-ml-2">
              <ChevronDown
                aria-hidden
                className={cn('transition-transform', rawOpen && 'rotate-180')}
              />
              {rawOpen ? 'Hide raw trace' : 'Show raw trace'}
            </Button>
          </CollapsibleTrigger>
          {rawOpen ? <CopyButton value={rawTrace} label="raw trace" size="icon-xs" /> : null}
        </div>
        <CollapsibleContent>
          <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed">
            {rawTrace}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </DetailSection>
  );
}
