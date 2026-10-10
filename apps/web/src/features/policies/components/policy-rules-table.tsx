'use client';

import { formatBps, type PolicyRuleDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
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
import type { AmountFormatOverride } from '@/providers/platform-settings-provider';

/** Read-only level rules: Level | Type | Amount / percentage | Cap (reward unit of the program). */
export function PolicyRulesTable({
  rules,
  rewardFormat,
  caption,
}: {
  rules: readonly PolicyRuleDto[];
  rewardFormat: AmountFormatOverride;
  caption: string;
}) {
  const sorted = [...rules].sort((a, b) => a.level - b.level);
  return (
    <Table>
      <TableCaption className="sr-only">{caption}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Level</TableHead>
          <TableHead>Type</TableHead>
          <TableHead className="text-right">Amount / percentage</TableHead>
          <TableHead className="text-right">Cap</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((rule) => (
          <TableRow key={rule.id}>
            <TableCell className="font-medium">Level {rule.level}</TableCell>
            <TableCell>{enumLabel('RewardCalcType', rule.calcType)}</TableCell>
            <TableCell className="text-right tabular-nums">
              {rule.calcType === 'PERCENTAGE' ? (
                rule.percentageBps !== null ? (
                  `${formatBps(rule.percentageBps)} of the sale`
                ) : (
                  '—'
                )
              ) : (
                <Amount value={rule.fixedAmountMinor} format={rewardFormat} />
              )}
            </TableCell>
            <TableCell className="text-right">
              <Amount value={rule.capMinor} format={rewardFormat} fallback="No cap" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
