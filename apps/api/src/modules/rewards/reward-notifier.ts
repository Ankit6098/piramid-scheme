import { Injectable } from '@nestjs/common';
import { formatAmount } from '@app/shared';
import type { Db } from '../../common/prisma/prisma.service';
import { PlatformSettingsService, toRecordAmountFormat } from '../../common/settings/platform-settings.service';
import type { RewardUnit } from '../../generated/prisma/client';
import { NotificationsService } from '../notifications/notifications.service';

export type RewardNoticeKind = 'posted' | 'rejected' | 'reversed';

export interface RewardNoticeInput {
  rewardId: string;
  recipientUserId: string;
  programId: string;
  amountMinor: bigint;
  rewardUnit: RewardUnit;
  currencyCode: string;
  kind: RewardNoticeKind;
  /** Rejection / reversal reason shown to the member. */
  reason?: string | null;
  /** The sale was refunded / charged back (event reversal). */
  saleReversed?: boolean;
}

/**
 * In-app notifications about reward decisions, enqueued in the caller's transaction (outbox) with a
 * per-reward dedupe key. Copy states recorded facts only — no projections.
 */
@Injectable()
export class RewardNotifier {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly settings: PlatformSettingsService,
  ) {}

  async notify(tx: Db, input: RewardNoticeInput): Promise<void> {
    const program = await tx.program.findUniqueOrThrow({
      where: { id: input.programId },
      select: { name: true, currencyMinorUnits: true },
    });
    // Read through the caller's transaction: a cold-cache read on the pool from inside a decision
    // transaction needs a second connection and deadlocks the pool under concurrent decisions.
    const { pointsLabel } = await this.settings.get(tx);
    const amount = formatAmount(
      input.amountMinor,
      toRecordAmountFormat(
        { rewardUnit: input.rewardUnit, currencyCode: input.currencyCode, currencyMinorUnits: program.currencyMinorUnits },
        pointsLabel,
      ),
    );
    const reason = input.reason ? ` Reason: ${input.reason}` : '';
    const copy: Record<RewardNoticeKind, { type: string; title: string; body: string }> = {
      posted: {
        type: 'reward.posted',
        title: 'Reward approved',
        body: `${amount} from ${program.name} was approved and added to your earnings.`,
      },
      rejected: {
        type: 'reward.rejected',
        title: input.saleReversed ? 'Reward cancelled' : 'Reward not approved',
        body: input.saleReversed
          ? `${amount} from ${program.name} was cancelled because the sale was refunded or reversed.${reason}`
          : `${amount} from ${program.name} was not approved.${reason}`,
      },
      reversed: {
        type: 'reward.reversed',
        title: 'Reward reversed',
        body: input.saleReversed
          ? `${amount} from ${program.name} was reversed because the sale was refunded or reversed.${reason}`
          : `${amount} from ${program.name} was reversed and removed from your earnings.${reason}`,
      },
    };
    const c = copy[input.kind];
    await this.notifications.notify(tx, {
      userId: input.recipientUserId,
      type: c.type,
      title: c.title,
      body: c.body.slice(0, 1000),
      data: { rewardId: input.rewardId, programId: input.programId },
      dedupeKey: `reward-${input.kind}:${input.rewardId}`,
    });
  }
}
