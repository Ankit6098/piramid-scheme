'use client';

import { ChevronDown, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { formatBps, type AdminRewardDetailDto, type AdminRewardTraceLevelDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { CopyButton } from '@/components/app/copy-button';
import { ToneBadge } from '@/components/app/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import type { AmountFormatOverride } from '@/providers/platform-settings-provider';

import { FigureBox } from '../../../finance/components/detail';
import { currencyFormat, unitFormat } from '../../../finance/lib';
import { ruleLabel, traceDecisionMeta } from '../../labels';

/** Share of `part` in `whole` as a percentage (0–100), from integer minor amounts. */
function pct(part: string | null, whole: string | null): number {
  if (!part || !whole) return 0;
  const w = BigInt(whole);
  if (w <= BigInt(0)) return 0;
  // Basis points of precision without floats on the amounts themselves.
  return Number((BigInt(part) * BigInt(10_000)) / w) / 100;
}

/**
 * Readable calculation trace (admin-only): inputs → budget → each level's decision, with a budget
 * meter showing how the sale's reward budget was allocated and which level is the viewed reward.
 */
export function CalculationTrace({ reward }: { reward: AdminRewardDetailDto }) {
  const calc = reward.calculation;
  const trace = calc.trace;
  const rewardFmt = unitFormat(calc);
  const saleFmt = currencyFormat(reward.event.currencyCode, calc.currencyMinorUnits);
  const awarded = trace.levels.filter((l) => l.decision === 'AWARDED' && l.amountMinor);

  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <FigureBox label="Sale amount">
          <Amount kind="currency" value={reward.event.amountMinor} format={saleFmt} />
        </FigureBox>
        <FigureBox
          label="Base"
          hint={calc.rewardUnit === 'POINTS' ? `${calc.pointsPerCurrencyUnit} points per currency unit` : 'Equals the sale amount'}
        >
          <Amount value={calc.baseMinor} format={rewardFmt} />
        </FigureBox>
        <FigureBox label="Budget" hint={`${formatBps(calc.budgetBps)} of base${trace.maxTotalPerEventMinor ? ', capped' : ''}`}>
          <Amount value={calc.budgetMinor} format={rewardFmt} />
        </FigureBox>
        <FigureBox label="Allocated" hint={`${awarded.length} ${awarded.length === 1 ? 'reward' : 'rewards'}`}>
          <Amount value={calc.totalAllocatedMinor} format={rewardFmt} />
        </FigureBox>
      </dl>

      <BudgetMeter levels={awarded} budgetMinor={calc.budgetMinor} totalMinor={calc.totalAllocatedMinor} format={rewardFmt} />

      {trace.warnings.length > 0 ? (
        <Alert>
          <TriangleAlert aria-hidden />
          <AlertTitle>Calculation notes</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {trace.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {trace.parsed ? (
        <section className="space-y-2" aria-label="Levels">
          <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Levels</h4>
          <ol className="space-y-2">
            {trace.levels.map((level) => (
              <LevelRow key={level.level} level={level} format={rewardFmt} />
            ))}
          </ol>
          {trace.levels.length === 0 ? <p className="text-sm text-muted-foreground">No levels were evaluated.</p> : null}
        </section>
      ) : (
        <Alert>
          <TriangleAlert aria-hidden />
          <AlertTitle>Trace format not recognised</AlertTitle>
          <AlertDescription>The stored calculation is shown as raw data below.</AlertDescription>
        </Alert>
      )}

      {trace.ancestors.length > 0 ? <AncestorsTable ancestors={trace.ancestors} /> : null}

      <RawTrace raw={trace.raw} engineVersion={calc.engineVersion} />
    </div>
  );
}

function BudgetMeter({
  levels,
  budgetMinor,
  totalMinor,
  format,
}: {
  levels: AdminRewardTraceLevelDto[];
  budgetMinor: string;
  totalMinor: string;
  format: AmountFormatOverride;
}) {
  const used = pct(totalMinor, budgetMinor);
  const label = `${used}% of the reward budget allocated across ${levels.length} level${levels.length === 1 ? '' : 's'}`;
  return (
    <figure className="space-y-2">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <span>Budget allocation</span>
        <span className="tabular-nums">{used}% used</span>
      </figcaption>
      {/* 2px surface gaps between segments; the viewed reward is the solid segment. */}
      <div role="img" aria-label={label} className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-muted">
        {levels.map((l) => {
          const width = pct(l.amountMinor, budgetMinor);
          if (width <= 0) return null;
          return (
            <div
              key={l.level}
              title={`Level ${l.level}${l.user ? ` · ${l.user.fullName}` : ''}`}
              className={cn('h-full first:rounded-l-full', l.isThisReward ? 'bg-primary' : 'bg-primary/35')}
              style={{ width: `${width}%` }}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <LegendSwatch className="bg-primary">This reward</LegendSwatch>
        <LegendSwatch className="bg-primary/35">Other levels</LegendSwatch>
        <LegendSwatch className="bg-muted ring-1 ring-inset ring-foreground/15">
          Unallocated <Amount value={(BigInt(budgetMinor) - BigInt(totalMinor)).toString()} format={format} />
        </LegendSwatch>
      </div>
    </figure>
  );
}

function LegendSwatch({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={cn('size-2.5 rounded-sm', className)} />
      {children}
    </span>
  );
}

function LevelRow({ level, format }: { level: AdminRewardTraceLevelDto; format: AmountFormatOverride }) {
  const meta = traceDecisionMeta(level.decision);
  const awarded = level.decision === 'AWARDED';
  return (
    <li
      className={cn(
        'rounded-lg border px-3 py-2.5',
        level.isThisReward ? 'border-primary/50 bg-primary/5 ring-1 ring-primary/30' : 'bg-card',
      )}
      aria-current={level.isThisReward ? 'true' : undefined}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-6 min-w-8 items-center justify-center rounded-md bg-muted px-1.5 text-xs font-semibold tabular-nums">
            L{level.level}
          </span>
          <span className="truncate font-medium">{level.user?.fullName ?? '—'}</span>
          {level.depth !== null && level.depth !== level.level ? (
            <span className="text-xs text-muted-foreground">(depth {level.depth})</span>
          ) : null}
          {level.isThisReward ? <ToneBadge tone="primary">This reward</ToneBadge> : null}
        </div>
        <div className="flex items-center gap-2">
          <ToneBadge tone={meta.tone} title={meta.description}>
            {meta.label}
          </ToneBadge>
          {awarded ? <Amount value={level.amountMinor} format={format} className="font-semibold" /> : null}
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {awarded || level.ruleAmountMinor ? (
          <>
            {ruleLabel(level.calcType, level.percentageBps)}
            {level.calcType === 'FIXED' && level.fixedAmountMinor ? (
              <>
                {' '}
                <Amount value={level.fixedAmountMinor} format={format} />
              </>
            ) : null}
            {level.ruleAmountMinor ? (
              <>
                {' '}
                → <Amount value={level.ruleAmountMinor} format={format} />
              </>
            ) : null}
            {level.capped && level.capMinor ? (
              <>
                {' '}
                · capped at <Amount value={level.capMinor} format={format} />
              </>
            ) : null}
            {level.budgetLimited ? ' · reduced to the remaining budget' : ''}
            {level.remainingBudgetMinor ? (
              <>
                {' '}
                · budget left <Amount value={level.remainingBudgetMinor} format={format} />
              </>
            ) : null}
          </>
        ) : (
          (level.reason ?? meta.description)
        )}
      </p>
      {level.reason && (awarded || level.ruleAmountMinor) ? <p className="mt-0.5 text-xs text-muted-foreground">{level.reason}</p> : null}
    </li>
  );
}

function AncestorsTable({ ancestors }: { ancestors: AdminRewardDetailDto['calculation']['trace']['ancestors'] }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="-ml-2">
          <ChevronDown className={cn('transition-transform', open && 'rotate-180')} aria-hidden />
          Upline members considered ({ancestors.length})
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <caption className="sr-only">Upline members considered at the sale date</caption>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">Depth</TableHead>
                <TableHead>Member</TableHead>
                <TableHead>Eligible at sale date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ancestors.map((a) => (
                <TableRow key={`${a.userId}-${a.depth}`}>
                  <TableCell className="tabular-nums">{a.depth}</TableCell>
                  <TableCell>{a.user?.fullName ?? a.userId.slice(0, 8)}</TableCell>
                  <TableCell className="whitespace-normal">
                    {a.eligible ? (
                      <ToneBadge tone="success">Eligible</ToneBadge>
                    ) : (
                      <span className="inline-flex flex-wrap items-center gap-2">
                        <ToneBadge tone="warning">Not eligible</ToneBadge>
                        {a.reason ? <span className="text-xs text-muted-foreground">{a.reason}</span> : null}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function RawTrace({ raw, engineVersion }: { raw: unknown; engineVersion: string }) {
  const [open, setOpen] = useState(false);
  const json = JSON.stringify(raw, null, 2);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex items-center justify-between gap-2">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="-ml-2">
            <ChevronDown className={cn('transition-transform', open && 'rotate-180')} aria-hidden />
            Raw trace (engine {engineVersion})
          </Button>
        </CollapsibleTrigger>
        {open ? <CopyButton value={json} label="calculation trace" size="sm" /> : null}
      </div>
      <CollapsibleContent>
        <pre className="max-h-80 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs">{json}</pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
