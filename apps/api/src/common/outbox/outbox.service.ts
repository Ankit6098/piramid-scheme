import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { toJsonValue } from '../http/json-safe';
import type { Db } from '../prisma/prisma.service';
import type { OutboxPayloads, OutboxTopic } from './outbox.topics';

export interface EnqueueInput<T extends OutboxTopic> {
  topic: T;
  payload: OutboxPayloads[T];
  /**
   * Optional de-duplication key (≤ 160 chars, unique). A second enqueue with the same key is a
   * no-op (`enqueued: false`) — it does NOT abort the surrounding transaction.
   */
  dedupeKey?: string;
  /** Deliver no earlier than this instant (default: now). */
  availableAt?: Date;
  /** Default 8. */
  maxAttempts?: number;
}

/**
 * Transactional outbox. Always enqueue INSIDE the transaction that makes the business change; the
 * worker's OutboxRelay delivers after commit (email via SMTP, in-app notifications, …).
 */
@Injectable()
export class OutboxService {
  async enqueue<T extends OutboxTopic>(tx: Db, input: EnqueueInput<T>): Promise<{ id: string; enqueued: boolean }> {
    const id = randomUUID();
    const res = await tx.outboxMessage.createMany({
      data: [
        {
          id,
          topic: input.topic,
          payload: toJsonValue(input.payload) as Prisma.InputJsonValue,
          dedupeKey: input.dedupeKey?.slice(0, 160) ?? null,
          ...(input.availableAt ? { availableAt: input.availableAt } : {}),
          ...(input.maxAttempts ? { maxAttempts: input.maxAttempts } : {}),
        },
      ],
      skipDuplicates: true, // ON CONFLICT DO NOTHING (dedupe_key)
    });
    return { id, enqueued: res.count === 1 };
  }
}
