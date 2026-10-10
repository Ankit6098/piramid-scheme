import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { toJsonValue } from '../http/json-safe';
import type { Db } from '../prisma/prisma.service';
import { OutboxTopic, type OutboxPayloads } from './outbox.topics';

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

/** Keys the DB rejects anywhere in an outbox payload (CHECK ck_outbox_no_plain_otp). */
const BANNED_PAYLOAD_KEYS = new Set(['code', 'otp']);

/**
 * Mirrors the outbox CHECK constraints in the application so violations fail early with a clear
 * message (instead of a 23514 at INSERT time): no `code`/`otp` keys at any depth, and
 * `codeCiphertext` only on `email.otp` messages (written by OtpMailer).
 */
export function assertOutboxPayloadSafe(topic: string, payload: unknown): void {
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => visit(v, `${path}[${i}]`));
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (BANNED_PAYLOAD_KEYS.has(k.toLowerCase())) {
        throw new Error(
          `Outbox payload key "${path}${k}" is not allowed (no "code"/"otp" keys; rename it, e.g. programCode; one-time codes go through OtpMailer)`,
        );
      }
      if (k === 'codeCiphertext' && (topic !== OutboxTopic.EmailOtp || path !== '')) {
        throw new Error('Only OtpMailer (topic email.otp) may put a codeCiphertext into an outbox payload');
      }
      visit(v, `${path}${k}.`);
    }
  };
  visit(payload, '');
}

/**
 * Transactional outbox. Always enqueue INSIDE the transaction that makes the business change; the
 * worker's OutboxRelay delivers after commit (email via SMTP, in-app notifications, …).
 */
@Injectable()
export class OutboxService {
  async enqueue<T extends OutboxTopic>(tx: Db, input: EnqueueInput<T>): Promise<{ id: string; enqueued: boolean }> {
    const payload = toJsonValue(input.payload);
    assertOutboxPayloadSafe(input.topic, payload);
    const id = randomUUID();
    const res = await tx.outboxMessage.createMany({
      data: [
        {
          id,
          topic: input.topic,
          payload: payload as Prisma.InputJsonValue,
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
