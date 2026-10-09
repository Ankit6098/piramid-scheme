import { Injectable } from '@nestjs/common';
import { OutboxService } from '../../common/outbox/outbox.service';
import type { NotificationCreatePayload } from '../../common/outbox/outbox.topics';
import type { Db } from '../../common/prisma/prisma.service';

export type NotifyInput = NotificationCreatePayload & {
  /** Optional de-duplication key, e.g. `reward-approved:<rewardId>`. */
  dedupeKey?: string;
};

/**
 * CROSS-MODULE CONTRACT (implemented in core): in-app notifications are created asynchronously via the
 * outbox so they commit atomically with the business change and never block it.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly outbox: OutboxService) {}

  /**
   * Enqueues a `notification.create` outbox message inside `tx`; the worker inserts the
   * `notifications` row after commit (idempotently).
   */
  async notify(tx: Db, input: NotifyInput): Promise<{ outboxId: string; enqueued: boolean }> {
    const { dedupeKey, ...payload } = input;
    const res = await this.outbox.enqueue(tx, {
      topic: 'notification.create',
      payload,
      ...(dedupeKey ? { dedupeKey: `notification:${dedupeKey}` } : {}),
    });
    return { outboxId: res.id, enqueued: res.enqueued };
  }
}
