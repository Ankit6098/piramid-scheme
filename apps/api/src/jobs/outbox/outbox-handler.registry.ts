import { Injectable } from '@nestjs/common';
import type { OutboxPayloads, OutboxTopic } from '../../common/outbox/outbox.topics';

export interface OutboxMessageView<P = unknown> {
  id: string;
  topic: string;
  payload: P;
  /** Attempt number of this delivery (1 = first). */
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
}

export type OutboxHandler<T extends OutboxTopic = OutboxTopic> = (
  message: OutboxMessageView<OutboxPayloads[T]>,
) => Promise<void>;

export interface OutboxHandlerRegistration<T extends OutboxTopic = OutboxTopic> {
  handle: OutboxHandler<T>;
  /**
   * Optional extra top-level payload keys to delete (`payload - keys`) in the same UPDATE that marks
   * the message SENT or DEAD. `codeCiphertext` is always removed (OUTBOX_TERMINAL_SCRUB_KEYS).
   */
  scrubKeys?: readonly string[];
}

/**
 * Throw from a handler to fail permanently (status DEAD immediately, no retries), e.g. for a payload
 * that can never be delivered (unknown template, missing user).
 */
export class PermanentOutboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentOutboxError';
  }
}

/**
 * Topic → handler map used by the OutboxRelay. Register from a provider's constructor/onModuleInit:
 *   constructor(registry: OutboxHandlerRegistry) { registry.register('notification.create', { handle: (m) => ... }) }
 * One handler per topic. Handlers run outside any DB transaction and must be idempotent
 * (delivery is at-least-once). Error messages end up in `last_error`: never put payload values,
 * codes or addresses in them (the relay additionally redacts payload strings).
 */
@Injectable()
export class OutboxHandlerRegistry {
  private readonly handlers = new Map<string, OutboxHandlerRegistration<never>>();

  register<T extends OutboxTopic>(topic: T, registration: OutboxHandlerRegistration<T>): void {
    if (this.handlers.has(topic)) throw new Error(`Outbox handler for "${topic}" is already registered`);
    this.handlers.set(topic, registration as unknown as OutboxHandlerRegistration<never>);
  }

  get(topic: string): OutboxHandlerRegistration<OutboxTopic> | undefined {
    return this.handlers.get(topic) as OutboxHandlerRegistration<OutboxTopic> | undefined;
  }

  topics(): string[] {
    return [...this.handlers.keys()];
  }
}
