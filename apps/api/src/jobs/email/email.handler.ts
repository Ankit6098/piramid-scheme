import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../config/app-config';
import type { EmailSendPayload } from '../../common/outbox/outbox.topics';
import { OutboxHandlerRegistry, PermanentOutboxError } from '../outbox/outbox-handler.registry';
import { EmailService } from './email.service';
import { isEmailTemplateName, renderEmail, type TemplateContext } from './templates';

export const APP_NAME = 'Referral Platform';

/**
 * SMTP failures become a generic error that carries only nodemailer's error code / SMTP status — never
 * the server response, which may echo the recipient address (last_error must stay free of PII).
 */
export function smtpError(err: unknown): Error {
  const e = (err ?? {}) as { code?: unknown; responseCode?: unknown };
  const parts = [typeof e.code === 'string' ? e.code : null, typeof e.responseCode === 'number' ? String(e.responseCode) : null].filter(Boolean);
  return new Error(`SMTP delivery failed${parts.length ? ` (${parts.join(' ')})` : ''}`);
}

/** Handles outbox topic `email.send`: render template → SMTP. (OTP emails: see OtpEmailOutboxHandler.) */
@Injectable()
export class EmailOutboxHandler {
  private readonly ctx: TemplateContext;

  constructor(
    registry: OutboxHandlerRegistry,
    private readonly email: EmailService,
    config: AppConfig,
  ) {
    this.ctx = { appName: APP_NAME, appUrl: config.app.publicUrl };
    registry.register('email.send', { handle: (message) => this.handle(message.payload) });
  }

  async handle(payload: EmailSendPayload): Promise<void> {
    if (!payload || typeof payload.to !== 'string' || !payload.to.includes('@')) {
      throw new PermanentOutboxError('email.send payload has no valid recipient');
    }
    if (!isEmailTemplateName(payload.template)) {
      throw new PermanentOutboxError(`Unknown email template "${String(payload.template)}"`);
    }
    const rendered = renderEmail(payload.template, payload.data as never, this.ctx);
    await this.email.send({ to: payload.to, template: payload.template, ...rendered }).catch((err: unknown) => {
      throw smtpError(err);
    });
  }
}
