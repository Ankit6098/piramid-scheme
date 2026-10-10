import { Injectable } from '@nestjs/common';
import type { ChallengePurpose } from '@app/shared';
import { CryptoService } from '../crypto/crypto.service';
import { hexDigestEquals } from '../crypto/hmac';
import type { Db } from '../prisma/prisma.service';
import { OutboxService } from './outbox.service';
import { OutboxTopic } from './outbox.topics';

/** OTP emails are worthless after the 10-minute TTL; retries back off 5 s, 10 s, 20 s, 40 s, 80 s. */
export const OTP_EMAIL_MAX_ATTEMPTS = 6;

export interface EnqueueOtpEmailInput {
  /** The `email_challenges` row (already inserted/updated in this transaction). */
  challengeId: string;
  /** The raw 6-digit code. Only its AES-GCM ciphertext leaves this method. */
  code: string;
  /** Must equal the challenge's (normalized) address — sanity check against wiring mistakes. */
  email: string;
  purpose: ChallengePurpose;
}

/**
 * The ONLY way to email a one-time code (business rules §2 "OTP delivery"). Call it inside the
 * transaction that writes the challenge:
 *
 *   const code = randomNumericCode();
 *   const ch = await tx.emailChallenge.create({ data: { ..., codeHash: crypto.otpCodeHash(purpose, email, code) } });
 *   await otpMailer.enqueue(tx, { challengeId: ch.id, code, email, purpose });
 *
 * The outbox payload is `{ challengeId, codeCiphertext, template: 'otp' }` (AES-256-GCM with
 * OTP_OUTBOX_KEY, AAD = challengeId). The worker re-checks that the challenge is still open and that
 * the code still matches `code_hash` (a re-issued code makes older messages stale), sends, and scrubs
 * the ciphertext in the UPDATE that marks the message SENT/DEAD.
 */
@Injectable()
export class OtpMailer {
  constructor(
    private readonly outbox: OutboxService,
    private readonly crypto: CryptoService,
  ) {}

  async enqueue(tx: Db, input: EnqueueOtpEmailInput): Promise<{ outboxId: string }> {
    if (!/^\d{6}$/.test(input.code)) throw new Error('OtpMailer.enqueue: the code must be 6 digits');
    const challenge = await tx.emailChallenge.findUnique({
      where: { id: input.challengeId },
      select: { email: true, purpose: true, codeHash: true, consumedAt: true, invalidatedAt: true },
    });
    if (!challenge) throw new Error('OtpMailer.enqueue: challenge not found (insert it in the same transaction first)');
    if (challenge.email !== input.email.trim().toLowerCase() || challenge.purpose !== input.purpose) {
      throw new Error('OtpMailer.enqueue: email/purpose do not match the challenge');
    }
    if (challenge.consumedAt || challenge.invalidatedAt) throw new Error('OtpMailer.enqueue: the challenge is closed');
    if (!hexDigestEquals(challenge.codeHash, this.crypto.otpCodeHash(challenge.purpose, challenge.email, input.code))) {
      throw new Error('OtpMailer.enqueue: code does not match the challenge code_hash (store CryptoService.otpCodeHash())');
    }
    const { id } = await this.outbox.enqueue(tx, {
      topic: OutboxTopic.EmailOtp,
      payload: {
        challengeId: input.challengeId,
        codeCiphertext: this.crypto.encryptOtpCode(input.code, input.challengeId),
        template: 'otp',
      },
      maxAttempts: OTP_EMAIL_MAX_ATTEMPTS,
    });
    return { outboxId: id };
  }
}
