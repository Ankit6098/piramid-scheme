import { Injectable } from '@nestjs/common';
import type { ChallengePurpose } from '@app/shared';
import { maskEmail } from '../../common/audit/mask';
import { CryptoService } from '../../common/crypto/crypto.service';
import { OutboxService } from '../../common/outbox/outbox.service';
import type { Db } from '../../common/prisma/prisma.service';
import { AppConfig } from '../../config/app-config';
import { NotificationsService } from '../notifications/notifications.service';
import { dayBucket, hourBucket } from './domain/otp-policy';

const PURPOSE_LABEL: Record<ChallengePurpose, string> = {
  EMAIL_VERIFICATION: 'email verification',
  LOGIN_MFA: 'sign-in verification',
  PASSWORD_RESET: 'password reset',
  EMAIL_CHANGE: 'email change',
};

/**
 * Security emails and in-app notices, always enqueued through the outbox INSIDE the business
 * transaction. Courtesy notices that an outsider can trigger (registration attempts, "address taken")
 * are de-duplicated per hour so they cannot be used to flood a mailbox. No payload ever carries a
 * one-time code (those go through OtpMailer).
 */
@Injectable()
export class SecurityNoticesService {
  constructor(
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly crypto: CryptoService,
    private readonly config: AppConfig,
  ) {}

  private url(path: string): string {
    return `${this.config.app.publicUrl}${path}`;
  }

  private key(kind: string, email: string, bucket: number): string {
    return `${kind}:${this.crypto.emailHmac(email, 'security-notice')}:${bucket}`;
  }

  /** "Someone tried to register with your address" (registration for an existing account). */
  async registrationAttempt(tx: Db, user: { email: string; fullName: string }, now: Date): Promise<void> {
    await this.outbox.enqueue(tx, {
      topic: 'email.send',
      payload: {
        to: user.email,
        template: 'registration-attempt-existing-account',
        data: { name: user.fullName, loginUrl: this.url('/login'), resetUrl: this.url('/forgot-password') },
      },
      dedupeKey: this.key('registration-attempt', user.email, hourBucket(now)),
    });
  }

  /** ≥ 10 failed code attempts in 24 h: codes for this purpose are blocked for a day. Once per day. */
  async otpCapReached(
    tx: Db,
    input: { to: string; name?: string | null; purpose: ChallengePurpose },
    now: Date,
  ): Promise<void> {
    const label = PURPOSE_LABEL[input.purpose];
    await this.outbox.enqueue(tx, {
      topic: 'email.send',
      payload: {
        to: input.to,
        template: 'generic',
        data: {
          subject: 'Security alert: too many incorrect codes',
          paragraphs: [
            input.name ? `Hello ${input.name},` : 'Hello,',
            `There were too many incorrect attempts to enter a ${label} code for this email address.`,
            'For your protection, new codes for this step are paused for 24 hours.',
            "If this wasn't you, no action is needed — your account (if any) has not been changed. If you are worried, change your password after the pause.",
          ],
        },
      },
      dedupeKey: this.key(`otp-cap:${input.purpose}`, input.to, dayBucket(now)),
    });
  }

  /**
   * Too many wrong authenticator codes for this (admin) account: TOTP verification is paused. Email +
   * in-app, once per day — whoever entered them knew the password.
   */
  async totpLocked(tx: Db, user: { id: string; email: string; fullName: string }, now: Date): Promise<void> {
    await this.outbox.enqueue(tx, {
      topic: 'email.send',
      payload: {
        to: user.email,
        template: 'generic',
        data: {
          subject: 'Security alert: too many incorrect authenticator codes',
          paragraphs: [
            `Hello ${user.fullName},`,
            'Someone signed in to your account with your password and then entered too many incorrect authenticator codes.',
            'For your protection, authenticator verification for your account is paused for a while and that session was signed out. Super Admins have been notified.',
            "If this wasn't you, your password is known to someone else: ask a Super Admin to send you a password reset.",
          ],
        },
      },
      dedupeKey: `totp-locked:${user.id}:${dayBucket(now)}`,
    });
    await this.notifications.notify(tx, {
      userId: user.id,
      type: 'security.totp_locked',
      title: 'Authenticator verification paused',
      body: 'Too many incorrect authenticator codes were entered for your account. Verification is paused for a while.',
      dedupeKey: `totp-locked:${user.id}:${dayBucket(now)}`,
    });
  }

  /** Someone tried to move another account onto this (taken) address. */
  async emailChangeTargetTaken(tx: Db, input: { to: string; name?: string | null }, now: Date): Promise<void> {
    await this.outbox.enqueue(tx, {
      topic: 'email.send',
      payload: {
        to: input.to,
        template: 'generic',
        data: {
          subject: 'Someone tried to use your email address',
          paragraphs: [
            input.name ? `Hello ${input.name},` : 'Hello,',
            'Another account tried to change its sign-in email to this address. Your address already belongs to your account, so nothing was changed.',
            "If this wasn't you, no action is needed.",
          ],
        },
      },
      dedupeKey: this.key('email-change-taken', input.to, hourBucket(now)),
    });
  }

  /** The password of this account was changed or reset. */
  async passwordChanged(tx: Db, user: { id: string; email: string; fullName: string }, how: 'changed' | 'reset'): Promise<void> {
    await this.outbox.enqueue(tx, {
      topic: 'email.send',
      payload: {
        to: user.email,
        template: 'generic',
        data: {
          subject: 'Your password was changed',
          paragraphs: [
            `Hello ${user.fullName},`,
            how === 'reset'
              ? 'The password for your account was reset with a code sent to this address. All devices were signed out.'
              : 'The password for your account was changed. Other devices were signed out.',
            "If you didn't do this, reset your password immediately and contact support.",
          ],
          actionLabel: 'Reset password',
          actionUrl: this.url('/forgot-password'),
        },
      },
    });
    await this.notifications.notify(tx, {
      userId: user.id,
      type: 'security.password_changed',
      title: 'Password changed',
      body: how === 'reset' ? 'Your password was reset and all devices were signed out.' : 'Your password was changed.',
    });
  }

  /**
   * A SUPER_ADMIN sent this account a password reset (the code itself goes out separately through
   * OtpMailer). Email + in-app; no code in the payload.
   */
  async adminPasswordResetStarted(tx: Db, user: { id: string; email: string; fullName: string }): Promise<void> {
    await this.outbox.enqueue(tx, {
      topic: 'email.send',
      payload: {
        to: user.email,
        template: 'generic',
        data: {
          subject: 'An administrator started a password reset for your account',
          paragraphs: [
            `Hello ${user.fullName},`,
            'An administrator started a password reset for your account and signed it out on every device.',
            'We sent a 6-digit code to this address in a separate email. Open the reset page and enter your email address, the code and a new password. The code expires in 10 minutes — if it expires first, ask an administrator to send a new one.',
            "If you didn't expect this, contact your platform administrator before using the code.",
          ],
          actionLabel: 'Reset password',
          actionUrl: this.url('/reset-password'),
        },
      },
    });
    await this.notifications.notify(tx, {
      userId: user.id,
      type: 'security.password_reset_started',
      title: 'Password reset started by an administrator',
      body: 'An administrator sent a password reset code to your email address and signed you out on every device.',
    });
  }

  /** The sign-in email was changed — sent to the OLD address. */
  async emailChanged(tx: Db, input: { userId: string; oldEmail: string; newEmail: string; name: string }): Promise<void> {
    await this.outbox.enqueue(tx, {
      topic: 'email.send',
      payload: {
        to: input.oldEmail,
        template: 'email-changed-notice',
        data: { name: input.name, newEmailMasked: maskEmail(input.newEmail), supportUrl: this.url('/') },
      },
    });
    await this.notifications.notify(tx, {
      userId: input.userId,
      type: 'security.email_changed',
      title: 'Email address changed',
      body: `Your sign-in email is now ${maskEmail(input.newEmail)}.`,
    });
  }

  /**
   * Notifies every ACTIVE SUPER_ADMIN (email + in-app) about a security-relevant event on an admin
   * account (password/email change, blocked self-service reset, authenticator reset). `subjectUserId`
   * is excluded from the recipients (they get their own notice). Only masked addresses in the text.
   */
  async notifySuperAdmins(
    tx: Db,
    input: { subjectUserId: string; title: string; paragraphs: string[]; dedupeKey?: string },
  ): Promise<number> {
    const admins = await tx.user.findMany({
      where: {
        status: 'ACTIVE',
        id: { not: input.subjectUserId },
        roles: { some: { role: { key: 'SUPER_ADMIN' } } },
      },
      select: { id: true, email: true, fullName: true },
      take: 50,
    });
    for (const admin of admins) {
      await this.outbox.enqueue(tx, {
        topic: 'email.send',
        payload: {
          to: admin.email,
          template: 'generic',
          data: {
            subject: `Security notice: ${input.title}`,
            paragraphs: [`Hello ${admin.fullName},`, ...input.paragraphs],
            actionLabel: 'Open the admin console',
            actionUrl: this.url('/admin'),
          },
        },
        ...(input.dedupeKey ? { dedupeKey: `${input.dedupeKey}:email:${admin.id}` } : {}),
      });
      await this.notifications.notify(tx, {
        userId: admin.id,
        type: 'security.admin_account',
        title: input.title,
        body: input.paragraphs.join(' ').slice(0, 1900),
        data: { subjectUserId: input.subjectUserId },
        ...(input.dedupeKey ? { dedupeKey: `${input.dedupeKey}:${admin.id}` } : {}),
      });
    }
    return admins.length;
  }
}
