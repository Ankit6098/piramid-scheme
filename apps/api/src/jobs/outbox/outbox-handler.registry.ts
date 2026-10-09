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
   * Optional: returns the payload to keep once the message is SENT or DEAD (e.g. drop OTP codes).
   * Must be JSON-compatible.
   */
  scrub?: (payload: OutboxPayloads[T]) => unknown;
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
 * (delivery is at-least-once).
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
