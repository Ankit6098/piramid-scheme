import type { ChallengePurpose } from '@app/shared';

/**
 * Outbox topics and their payloads. Adding a topic: add it here (core-owned, coordinate), then
 * register a handler with `OutboxHandlerRegistry.register(topic, handler)` in a worker-side provider.
 */
export const OutboxTopic = {
  EmailSend: 'email.send',
  NotificationCreate: 'notification.create',
} as const;
export type OutboxTopic = (typeof OutboxTopic)[keyof typeof OutboxTopic];

// ─── email.send ─────────────────────────────────────────────────────────────

export interface OtpEmailData {
  /** The raw one-time code. Scrubbed from the outbox row once delivered or dead. */
  code: string;
  purpose: ChallengePurpose;
  expiresInMinutes: number;
  name?: string;
}
export interface RegistrationAttemptEmailData {
  name?: string;
  /** e.g. `${APP_PUBLIC_URL}/login` and `/forgot-password` */
  loginUrl: string;
  resetUrl: string;
}
export interface EmailChangedNoticeData {
  name?: string;
  /** Masked new address, e.g. "j***@example.com". */
  newEmailMasked: string;
  supportUrl?: string;
}
export interface RewardStatusEmailData {
  name?: string;
  programName: string;
  status: 'APPROVED' | 'POSTED' | 'REJECTED' | 'REVERSED' | 'PENDING_APPROVAL';
  /** Pre-formatted with formatAmount() — templates never format money themselves. */
  amountFormatted: string;
  reason?: string;
  url?: string;
}
export interface EnrollmentStatusEmailData {
  name?: string;
  programName: string;
  optionName?: string;
  status: 'PENDING' | 'ACTIVE' | 'CANCELLED' | 'EXPIRED' | 'REJECTED';
  reason?: string;
  url?: string;
}
export interface GenericEmailData {
  subject: string;
  /** Plain-text paragraphs (escaped in the HTML version). */
  paragraphs: string[];
  actionLabel?: string;
  actionUrl?: string;
}

export interface EmailTemplateData {
  otp: OtpEmailData;
  'registration-attempt-existing-account': RegistrationAttemptEmailData;
  'email-changed-notice': EmailChangedNoticeData;
  'reward-status': RewardStatusEmailData;
  'enrollment-status': EnrollmentStatusEmailData;
  generic: GenericEmailData;
}
export type EmailTemplateName = keyof EmailTemplateData;

/** Discriminated union: `{ to, template: 'otp', data: OtpEmailData }` etc. */
export type EmailSendPayload = {
  [K in EmailTemplateName]: { to: string; template: K; data: EmailTemplateData[K] };
}[EmailTemplateName];

// ─── notification.create ────────────────────────────────────────────────────

export interface NotificationCreatePayload {
  userId: string;
  /** Machine type, e.g. 'reward.approved', 'enrollment.activated' (≤ 64 chars). */
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface OutboxPayloads {
  'email.send': EmailSendPayload;
  'notification.create': NotificationCreatePayload;
}
