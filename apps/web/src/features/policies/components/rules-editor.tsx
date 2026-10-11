'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useFieldArray, useFormState, useWatch, type Control } from 'react-hook-form';
import { formatBps, POLICY_MAX_DEPTH, type PolicyProgramContextDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { FormAmountField, FormSelect } from '@/components/app/form';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';
import type { AmountFormatOverride } from '@/providers/platform-settings-provider';

import { nextFreeLevel, type PolicyFormOutput, type PolicyFormValues } from '../form';
import { BudgetBar, BudgetLegendItem } from './budget-bar';
import { FormNumberSelect, FormPercentField } from './fields';

type PolicyControl = Control<PolicyFormValues, unknown, PolicyFormOutput>;

const CALC_TYPE_OPTIONS = [
  { value: 'PERCENTAGE', label: 'Percentage of sale' },
  { value: 'FIXED', label: 'Fixed amount' },
];

export interface RulesEditorProps {
  control: PolicyControl;
  program: PolicyProgramContextDto;
  rewardFormat: AmountFormatOverride;
  hardCapBps: number;
}

/** Level rules (one row per level) + Σ percentage vs budget vs hard cap. */
export function RulesEditor({ control, program, rewardFormat, hardCapBps }: RulesEditorProps) {
  const { fields, append, remove } = useFieldArray({ control, name: 'rules' });
  const rules = useWatch({ control, name: 'rules' });
  const maxDepthValue = useWatch({ control, name: 'maxDepth' });
  const budgetValue = useWatch({ control, name: 'budgetBps' });
  const { errors } = useFormState({ control, name: 'rules' });

  const maxDepth = typeof maxDepthValue === 'number' ? maxDepthValue : 1;
  const budgetBps = typeof budgetValue === 'number' ? budgetValue : 0;
  const rows = rules ?? [];
  const nextLevel = nextFreeLevel(rows, maxDepth);
  const canAdd = nextLevel !== null && fields.length < POLICY_MAX_DEPTH;

  let percentageTotal = 0;
  let fixedTotal = BigInt(0);
  let fixedCount = 0;
  for (const rule of rows) {
    if (rule?.calcType === 'PERCENTAGE' && typeof rule.percentageBps === 'number') {
      percentageTotal += rule.percentageBps;
    }
    if (rule?.calcType === 'FIXED') {
      fixedCount++;
      if (typeof rule.fixedAmountMinor === 'string' && /^\d+$/.test(rule.fixedAmountMinor)) {
        fixedTotal += BigInt(rule.fixedAmountMinor);
      }
    }
  }
  const overBudget = percentageTotal > budgetBps;
  const rootError =
    (errors.rules as { root?: { message?: string }; message?: string } | undefined)?.root
      ?.message ?? (errors.rules as { message?: string } | undefined)?.message;

  return (
    <div className="space-y-4">
      {fields.length > 0 ? (
        <ol className="space-y-3" aria-label="Reward levels">
          {fields.map((item, index) => (
            <RuleRow
              key={item.id}
              control={control}
              index={index}
              rows={rows}
              maxDepth={maxDepth}
              program={program}
              onRemove={() => remove(index)}
            />
          ))}
        </ol>
      ) : (
        <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
          No reward levels yet. Add at least one level before publishing.
        </p>
      )}
      {rootError ? <FieldError>{rootError}</FieldError> : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canAdd}
          onClick={() =>
            nextLevel !== null &&
            append({
              level: nextLevel,
              calcType: 'PERCENTAGE',
              percentageBps: null,
              fixedAmountMinor: null,
              capMinor: null,
            })
          }
        >
          <Plus aria-hidden />
          Add level{nextLevel !== null ? ` ${nextLevel}` : ''}
        </Button>
        {nextLevel === null ? (
          <p className="text-xs text-muted-foreground">
            Every level up to the maximum depth ({maxDepth}) has a rule
            {maxDepth < program.maxRewardDepth ? ' — increase the maximum depth to add more.' : '.'}
          </p>
        ) : null}
      </div>

      <div className="space-y-2 rounded-lg bg-muted/40 p-3">
        <p className="text-sm">
          Percentage levels add up to{' '}
          <span className={overBudget ? 'font-semibold text-destructive' : 'font-semibold'}>
            {formatBps(percentageTotal)}
          </span>{' '}
          of the sale — budget {formatBps(budgetBps)}, hard cap {formatBps(hardCapBps)}.
          {overBudget ? (
            <span className="block text-destructive">
              Percentage levels exceed the budget; this version can&apos;t be published until they
              fit.
            </span>
          ) : null}
        </p>
        <BudgetBar
          allocated={BigInt(percentageTotal)}
          budget={BigInt(budgetBps)}
          hardCap={BigInt(hardCapBps)}
          label={`Percentage levels ${formatBps(percentageTotal)} of a ${formatBps(
            budgetBps,
          )} budget; hard cap ${formatBps(hardCapBps)}`}
          legend={
            <>
              <BudgetLegendItem swatch="used">Percentage levels</BudgetLegendItem>
              {overBudget ? <BudgetLegendItem swatch="over">Over budget</BudgetLegendItem> : null}
              <BudgetLegendItem swatch="remaining">Unused budget</BudgetLegendItem>
              <BudgetLegendItem swatch="marker">Budget</BudgetLegendItem>
              <BudgetLegendItem swatch="cap">Up to the 50% hard cap</BudgetLegendItem>
            </>
          }
        />
        {fixedCount > 0 ? (
          <p className="text-xs text-muted-foreground">
            Fixed levels add up to <Amount value={fixedTotal.toString()} format={rewardFormat} />{' '}
            per sale. They are credited only while the sale&apos;s budget allows, so small sales may
            fund only the first levels.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function RuleRow({
  control,
  index,
  rows,
  maxDepth,
  program,
  onRemove,
}: {
  control: PolicyControl;
  index: number;
  rows: readonly PolicyFormValues['rules'][number][];
  maxDepth: number;
  program: PolicyProgramContextDto;
  onRemove: () => void;
}) {
  const calcType = useWatch({ control, name: `rules.${index}.calcType` });
  const level = useWatch({ control, name: `rules.${index}.level` });
  const usedByOthers = new Set(rows.filter((_, i) => i !== index).map((rule) => rule?.level));
  const highest = Math.max(maxDepth, typeof level === 'number' ? level : 0);
  const levelOptions = Array.from({ length: highest }, (_, i) => i + 1).map((value) => ({
    value,
    label: value > maxDepth ? `Level ${value} (beyond max depth)` : `Level ${value}`,
    disabled: usedByOthers.has(value),
  }));
  const beyondDepth = typeof level === 'number' && level > maxDepth;
  const rowLabel = typeof level === 'number' ? `level ${level}` : `row ${index + 1}`;

  return (
    <li className="rounded-lg border bg-card p-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[8rem_11rem_minmax(0,1fr)_minmax(0,1fr)_auto] xl:items-start">
        <FormNumberSelect
          control={control}
          name={`rules.${index}.level`}
          label="Level"
          options={levelOptions}
          required
        />
        <FormSelect
          control={control}
          name={`rules.${index}.calcType`}
          label="Type"
          options={CALC_TYPE_OPTIONS}
          required
        />
        {calcType === 'FIXED' ? (
          <FormAmountField
            control={control}
            name={`rules.${index}.fixedAmountMinor`}
            label="Fixed amount"
            kind="reward"
            unit={program.rewardUnit}
            currencyCode={program.currencyCode}
            minorUnits={program.currencyMinorUnits}
            emptyValue={null}
            required
          />
        ) : (
          <FormPercentField
            control={control}
            name={`rules.${index}.percentageBps`}
            label="Percentage"
            suffix="of sale"
            required
          />
        )}
        <FormAmountField
          control={control}
          name={`rules.${index}.capMinor`}
          label="Cap (optional)"
          kind="reward"
          unit={program.rewardUnit}
          currencyCode={program.currencyCode}
          minorUnits={program.currencyMinorUnits}
          emptyValue={null}
          placeholder="No cap"
        />
        <div className="flex items-end sm:col-span-2 xl:col-span-1 xl:pt-6">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRemove}
            aria-label={`Remove ${rowLabel}`}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 aria-hidden />
            <span className="xl:sr-only">Remove</span>
          </Button>
        </div>
      </div>
      {beyondDepth ? (
        <p className="mt-2 text-xs text-warning">
          Level {level} is deeper than the maximum depth ({maxDepth}) and would never be credited. Remove it
          or increase the maximum depth.
        </p>
      ) : null}
      {calcType === 'FIXED' ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Credited in {program.rewardUnit === 'POINTS' ? 'points' : program.currencyCode} per qualifying
          sale, and only while the sale&apos;s budget allows.
        </p>
      ) : null}
    </li>
  );
}
