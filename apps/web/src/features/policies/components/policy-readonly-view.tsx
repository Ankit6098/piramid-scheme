'use client';

import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  formatBps,
  Permission,
  POLICY_HARD_CAP_BPS,
  type PolicyContextDto,
  type PolicyVersionDto,
} from '@app/shared';

import { Amount } from '@/components/app/amount';
import { DateTime } from '@/components/app/date-time';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { useSession } from '@/hooks/use-session';
import { enumLabel, enumMeta } from '@/lib/enum-labels';

import { currencyFormat, rewardFormat } from '../format';
import { approvalModeLabel } from '../labels';
import { PanelSectionHeader } from './panel-section-header';
import { BudgetBar, BudgetLegendItem } from './budget-bar';
import { DryRunPanel } from './dry-run-panel';
import { EffectiveRange } from './policy-badges';
import { PolicyRulesTable } from './policy-rules-table';

/** All fields of a version, read-only (published / retired versions, or drafts without edit rights). */
export function PolicyReadOnlyView({
  policy,
  context,
}: {
  policy: PolicyVersionDto;
  context: PolicyContextDto;
}) {
  const { can } = useSession();
  const program = policy.program;
  const tz = program.timezone;
  const rewardFmt = rewardFormat(program, context.pointsLabel);
  const currencyFmt = currencyFormat(program);
  const hardCapBps = context.hardCapBps || POLICY_HARD_CAP_BPS;
  const isDraft = policy.status === 'DRAFT';
  const fixedLevels = policy.rules.filter((rule) => rule.calcType === 'FIXED').length;

  return (
    <div className="space-y-6">
      {isDraft ? (
        <Alert>
          <Lock aria-hidden />
          <AlertTitle>Read-only draft</AlertTitle>
          <AlertDescription>
            Your role can view this draft but not edit or publish it.
          </AlertDescription>
        </Alert>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lock className="size-3.5" aria-hidden />
          Published versions can&apos;t be edited. Clone this version to change it.
        </p>
      )}

      <Card>
        <CardContent>
          <PanelSectionHeader title="Configuration" className="mb-4" />
          <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            <Item label="Effective">
              <EffectiveRange
                phase={policy.phase}
                effectiveFrom={policy.effectiveFrom}
                effectiveTo={policy.effectiveTo}
                timeZone={tz}
                showTimeZone
              />
            </Item>
            <Item label="Sales priced by this version">
              <span className="tabular-nums">{policy.boundEventCount.toLocaleString('en')}</span>
            </Item>
            <Item label="Qualifying sale types">
              {policy.triggerEventTypes
                .map((type) => enumLabel('QualifyingEventType', type))
                .join(', ')}
            </Item>
            <Item label="Minimum sale amount">
              <Amount kind="currency" value={policy.minEventAmountMinor} format={currencyFmt} />
            </Item>
            <Item label="Total reward budget">
              <span className="tabular-nums">{formatBps(policy.budgetBps)}</span>{' '}
              <span className="text-muted-foreground">of the sale value</span>
            </Item>
            <Item label="Maximum total per sale">
              <Amount value={policy.maxTotalPerEventMinor} format={rewardFmt} fallback="No limit" />
            </Item>
            {program.rewardUnit === 'POINTS' ? (
              <Item label="Points rate">
                <span className="tabular-nums">
                  {policy.pointsPerCurrencyUnit.toLocaleString('en')}
                </span>{' '}
                {context.pointsLabel} per 1 {program.currencyCode} of sale value
              </Item>
            ) : null}
            <Item label="Maximum depth">
              <span className="tabular-nums">{policy.maxDepth}</span>{' '}
              {policy.maxDepth === 1 ? 'level' : 'levels'}
            </Item>
            <Item label="Ineligible upline members">
              {enumLabel('IneligibleAncestorBehavior', policy.ineligibleAncestorBehavior)}
              <span className="block text-xs text-muted-foreground">
                {
                  enumMeta('IneligibleAncestorBehavior', policy.ineligibleAncestorBehavior)
                    .description
                }
              </span>
            </Item>
            <Item label="Rounding">{enumLabel('RoundingMode', policy.roundingMode)}</Item>
            <Item label="Approval">
              {approvalModeLabel(policy.requiresApproval)}
              <span className="block text-xs text-muted-foreground">
                Rewards from manually recorded sales always need approval.
              </span>
            </Item>
            <Item label="Recipients need an active, eligible enrollment">
              {policy.requireActiveEnrollment ? 'Yes' : 'No'}
            </Item>
            <Item label="Created">
              <DateTime value={policy.createdAt} timeZone={tz} />
              {policy.createdBy ? ` by ${policy.createdBy.fullName}` : ''}
            </Item>
            {policy.publishedAt ? (
              <Item label="Published">
                <DateTime value={policy.publishedAt} timeZone={tz} />
                {policy.publishedBy ? ` by ${policy.publishedBy.fullName}` : ''}
              </Item>
            ) : null}
            {policy.retiredAt ? (
              <Item label="Retired">
                <DateTime value={policy.retiredAt} timeZone={tz} />
              </Item>
            ) : null}
            {policy.notes ? (
              <Item label="Notes" className="sm:col-span-2">
                <span className="whitespace-pre-line">{policy.notes}</span>
              </Item>
            ) : null}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4">
          <PanelSectionHeader
            title="Reward levels"
            description={`${policy.rules.length} ${policy.rules.length === 1 ? 'level' : 'levels'}${
              fixedLevels > 0 ? `, ${fixedLevels} with a fixed amount` : ''
            }. Levels are paid in order until the budget is used up.`}
          />
          {policy.rules.length > 0 ? (
            <PolicyRulesTable
              rules={policy.rules}
              rewardFormat={rewardFmt}
              caption={`Reward levels of version ${policy.version}`}
            />
          ) : (
            <p className="text-sm text-muted-foreground">No reward levels defined.</p>
          )}
          <BudgetBar
            allocated={BigInt(policy.percentageTotalBps)}
            budget={BigInt(policy.budgetBps)}
            hardCap={BigInt(hardCapBps)}
            label={`Percentage levels add up to ${formatBps(policy.percentageTotalBps)} of a ${formatBps(
              policy.budgetBps,
            )} budget; hard cap ${formatBps(hardCapBps)}`}
            legend={
              <>
                <BudgetLegendItem swatch="used">
                  Percentage levels {formatBps(policy.percentageTotalBps)}
                </BudgetLegendItem>
                <BudgetLegendItem swatch="marker">
                  Budget {formatBps(policy.budgetBps)}
                </BudgetLegendItem>
                <BudgetLegendItem swatch="cap">Hard cap {formatBps(hardCapBps)}</BudgetLegendItem>
              </>
            }
          />
        </CardContent>
      </Card>

      {can(Permission.PoliciesWrite) ? <DryRunPanel policy={policy} context={context} /> : null}
    </div>
  );
}

function Item({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}
