import { Injectable, Logger } from '@nestjs/common';
import { CryptoService } from '../../common/crypto/crypto.service';
import { hexDigestEquals } from '../../common/crypto/hmac';
import type { OtpEmailPayload } from '../../common/outbox/outbox.topics';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AppConfig } from '../../config/app-config';
import { OutboxHandlerRegistry, PermanentOutboxError, type OutboxMessageView } from '../outbox/outbox-handler.registry';
import { APP_NAME, smtpError } from './email.handler';
import { EmailService } from './email.service';
import { renderOtpEmail, type TemplateContext } from './templates';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OtpDeliveryResult = 'sent' | 'skipped:missing' | 'skipped:consumed' | 'skipped:invalidated' | 'skipped:expired' | 'skipped:stale';

/**
 * Handles outbox topic `email.otp` (payload `{ challengeId, codeCiphertext, template }`, written by
 * OtpMailer):
 * 1. loads the challenge; skips (→ SENT, ciphertext scrubbed) when it is gone, consumed, invalidated
 *    or expired;
 * 2. decrypts the code (AES-256-GCM, AAD = challengeId) — failure is permanent (→ DEAD, scrubbed);
 * 3. skips when the code no longer matches `code_hash` (the challenge was re-issued with a new code);
 * 4. sends the purpose-specific email to the challenge's address.
 * The relay removes `codeCiphertext` in the same UPDATE that marks the row SENT/DEAD. Errors thrown
 * from here never contain the code, the ciphertext or the address.
 */
@Injectable()
export class OtpEmailOutboxHandler {
  private readonly logger = new Logger(OtpEmailOutboxHandler.name);
  private readonly ctx: TemplateContext;

  constructor(
    registry: OutboxHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly email: EmailService,
    config: AppConfig,
  ) {
    this.ctx = { appName: APP_NAME, appUrl: config.app.publicUrl };
    registry.register('email.otp', {
      handle: async (message) => {
        await this.handle(message);
      },
    });
  }

  async handle(message: OutboxMessageView<OtpEmailPayload>, now: Date = new Date()): Promise<OtpDeliveryResult> {
    const p = message.payload as Partial<OtpEmailPayload> | null;
    if (!p || typeof p.challengeId !== 'string' || !UUID_RE.test(p.challengeId)) {
      throw new PermanentOutboxError('email.otp payload has no valid challengeId');
    }
    if (typeof p.codeCiphertext !== 'string' || p.codeCiphertext.length === 0) {
      throw new PermanentOutboxError('email.otp payload has no ciphertext');
    }
    if (p.template !== 'otp') throw new PermanentOutboxError('email.otp payload has an unknown template');

    const challenge = await this.prisma.emailChallenge.findUnique({
      where: { id: p.challengeId },
      select: {
        email: true,
        purpose: true,
        codeHash: true,
        expiresAt: true,
        consumedAt: true,
        invalidatedAt: true,
        pendingFullName: true,
        user: { select: { fullName: true } },
      },
    });
    const skip = (result: Exclude<OtpDeliveryResult, 'sent'>): OtpDeliveryResult => {
      this.logger.log({ outboxId: message.id, challengeId: p.challengeId, result }, 'OTP email skipped');
      return result;
    };
    if (!challenge) return skip('skipped:missing');
    if (challenge.consumedAt) return skip('skipped:consumed');
    if (challenge.invalidatedAt) return skip('skipped:invalidated');
    if (challenge.expiresAt.getTime() <= now.getTime()) return skip('skipped:expired');

    let code: string;
    try {
      code = this.crypto.decryptOtpCode(p.codeCiphertext, p.challengeId);
    } catch {
      throw new PermanentOutboxError('email.otp ciphertext could not be decrypted (wrong key, wrong challenge or tampered)');
    }
    if (!hexDigestEquals(challenge.codeHash, this.crypto.otpCodeHash(challenge.purpose, challenge.email, code))) {
      return skip('skipped:stale');
    }

    const rendered = renderOtpEmail(
      {
        code,
        purpose: challenge.purpose,
        expiresInMinutes: Math.max(1, Math.ceil((challenge.expiresAt.getTime() - now.getTime()) / 60_000)),
        ...((challenge.user?.fullName ?? challenge.pendingFullName) ? { name: (challenge.user?.fullName ?? challenge.pendingFullName)! } : {}),
      },
      this.ctx,
    );
    try {
      await this.email.send({ to: challenge.email, template: `otp:${challenge.purpose}`, ...rendered });
    } catch (err) {
      throw smtpError(err);
    }
    return 'sent';
  }
}
