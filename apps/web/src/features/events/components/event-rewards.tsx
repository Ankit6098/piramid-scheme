'use client';

import type { SaleEventRewardDto } from '@app/shared';

import { Amount } from '@/components/app/amount';
import { DateTime } from '@/components/app/date-time';
import { StatusBadge } from '@/components/app/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

function RewardDates({ reward, timeZone }: { reward: SaleEventRewardDto; timeZone: string }) {
  const decisions: { label: string; value: string | null }[] = [
    { label: 'Approved', value: reward.approvedAt },
    { label: 'Posted', value: reward.postedAt },
    { label: 'Rejected', value: reward.rejectedAt },
    { label: 'Reversed', value: reward.reversedAt },
  ];
  return (
    <ul className="space-y-0.5 text-xs text-muted-foreground">
      <li>
        Created <DateTime value={reward.createdAt} timeZone={timeZone} style="datetime" />
      </li>
      {decisions
        .filter((d) => d.value)
        .map((d) => (
          <li key={d.label}>
            {d.label} <DateTime value={d.value} timeZone={timeZone} style="datetime" />
          </li>
        ))}
    </ul>
  );
}

function RewardReason({ reward }: { reward: SaleEventRewardDto }) {
  const reason = reward.reversalReason ?? reward.rejectionReason;
  if (!reason) return null;
  return <p className="text-xs text-muted-foreground">{reason}</p>;
}

/**
 * Rewards created for one sale. Amounts use each reward's own unit/currency (+ the program's minor
 * units), never the live platform settings.
 */
export function EventRewards({
  rewards,
  minorUnits,
  timeZone,
}: {
  rewards: readonly SaleEventRewardDto[];
  minorUnits: number;
  timeZone: string;
}) {
  const sorted = [...rewards].sort((a, b) => a.level - b.level);
  return (
    <>
      {/* Table from sm up */}
      <div className="hidden rounded-lg border sm:block">
        <Table>
          <caption className="sr-only">Rewards created for this sale</caption>
          <TableHeader className="bg-muted/40">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-14 px-3 text-xs">Level</TableHead>
              <TableHead className="px-3 text-xs">Recipient</TableHead>
              <TableHead className="px-3 text-right text-xs">Amount</TableHead>
              <TableHead className="px-3 text-xs">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((reward) => (
              <TableRow key={reward.id} className="align-top">
                <TableCell className="px-3 py-2.5 tabular-nums">{reward.level}</TableCell>
                <TableCell className="px-3 py-2.5 whitespace-normal">
                  <span className="block font-medium">{reward.recipient.fullName}</span>
                  <RewardDates reward={reward} timeZone={timeZone} />
                </TableCell>
                <TableCell className="px-3 py-2.5 text-right">
                  <Amount
                    value={reward.amountMinor}
                    format={{
                      unit: reward.rewardUnit,
                      currencyCode: reward.currencyCode,
                      minorUnits,
                    }}
                    className="font-medium"
                  />
                </TableCell>
                <TableCell className="max-w-48 px-3 py-2.5 whitespace-normal">
                  <span className="flex flex-col gap-1">
                    <StatusBadge kind="RewardStatus" value={reward.status} />
                    <RewardReason reward={reward} />
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Stacked list on phones */}
      <ul className="divide-y rounded-lg border sm:hidden">
        {sorted.map((reward) => (
          <li key={reward.id} className="space-y-1.5 px-3 py-2.5">
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0">
                <span className="block text-xs text-muted-foreground">Level {reward.level}</span>
                <span className="block truncate font-medium">{reward.recipient.fullName}</span>
              </span>
              <Amount
                value={reward.amountMinor}
                format={{ unit: reward.rewardUnit, currencyCode: reward.currencyCode, minorUnits }}
                className="font-medium"
              />
            </div>
            <StatusBadge kind="RewardStatus" value={reward.status} />
            <RewardReason reward={reward} />
            <RewardDates reward={reward} timeZone={timeZone} />
          </li>
        ))}
      </ul>
    </>
  );
}
