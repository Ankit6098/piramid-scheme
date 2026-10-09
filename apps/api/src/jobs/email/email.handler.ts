import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../config/app-config';
import type { EmailSendPayload } from '../../common/outbox/outbox.topics';
import { OutboxHandlerRegistry, PermanentOutboxError } from '../outbox/outbox-handler.registry';
import { EmailService } from './email.service';
import { isEmailTemplateName, renderEmail, type TemplateContext } from './templates';

export const APP_NAME = 'Referral Platform';

/** Removes one-time codes from a delivered/dead email payload. */
export function scrubEmailPayload(payload: EmailSendPayload): unknown {
  if (payload.template === 'otp') return { ...payload, data: { ...payload.data, code: '[redacted]' } };
  return payload;
}

/** Handles outbox topic `email.send`: render template → SMTP. */
@Injectable()
export class EmailOutboxHandler {
  private readonly ctx: TemplateContext;

  constructor(
    registry: OutboxHandlerRegistry,
    private readonly email: EmailService,
    config: AppConfig,
  ) {
    this.ctx = { appName: APP_NAME, appUrl: config.app.publicUrl };
    registry.register('email.send', {
      handle: (message) => this.handle(message.payload),
      scrub: scrubEmailPayload,
    });
  }

  async handle(payload: EmailSendPayload): Promise<void> {
    if (!payload || typeof payload.to !== 'string' || !payload.to.includes('@')) {
      throw new PermanentOutboxError('email.send payload has no valid recipient');
    }
    if (!isEmailTemplateName(payload.template)) {
      throw new PermanentOutboxError(`Unknown email template "${String(payload.template)}"`);
    }
    const rendered = renderEmail(payload.template, payload.data as never, this.ctx);
    await this.email.send({ to: payload.to, template: payload.template, ...rendered });
  }
}
