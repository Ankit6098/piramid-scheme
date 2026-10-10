import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { maskEmail } from '../../common/audit/mask';
import { AppConfig } from '../../config/app-config';
import type { RenderedEmail } from './templates';


export interface SendEmailInput extends RenderedEmail {
  to: string;
  /** Template name, for logs only. */
  template?: string;
}

/**
 * SMTP delivery (nodemailer; Mailpit in development). Used by the outbox handler only — feature code
 * enqueues `email.send` through OutboxService and never sends mail inside a request/transaction.
 * Never logs message bodies (OTP codes) or full addresses.
 */
@Injectable()
export class EmailService implements OnModuleDestroy {
  private readonly logger = new Logger(EmailService.name);
  private transporter: Transporter | null = null;

  constructor(private readonly config: AppConfig) {}

  private get transport(): Transporter {
    if (!this.transporter) {
      const { host, port, secure, user, password } = this.config.mail;
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        ...(user ? { auth: { user, pass: password ?? '' } } : {}),
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
        logger: false,
        debug: false,
      });
    }
    return this.transporter;
  }

  async send(input: SendEmailInput): Promise<{ messageId: string }> {
    const info = (await this.transport.sendMail({
      from: this.config.mail.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    })) as { messageId?: string };
    this.logger.log({ template: input.template, to: maskEmail(input.to), messageId: info.messageId }, 'Email sent');
    return { messageId: info.messageId ?? '' };
  }

  onModuleDestroy(): void {
    this.transporter?.close();
    this.transporter = null;
  }
}
