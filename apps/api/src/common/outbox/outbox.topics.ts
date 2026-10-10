/**
 * Outbox topics and their payloads. Adding a topic: add it here (core-owned, coordinate), then
 * register a handler with `OutboxHandlerRegistry.register(topic, handler)` in a worker-side provider.
 *
 * PAYLOAD RULES (enforced by DB CHECKs and by `OutboxService.enqueue`):
 * - no key named `code` or `otp` anywhere in a payload (case-insensitive) — name template fields
 *   `programCode`, `referralCode`, … instead. One-time codes are sent ONLY via `OtpMailer` (topic
 *   `email.otp`), which stores an AES-GCM ciphertext under `codeCiphertext`;
 * - `codeCiphertext` is removed from the row in the same UPDATE that marks it SENT or DEAD.
 */
export const OutboxTopic = {
  EmailSend: 'email.send',
  EmailOtp: 'email.otp',
  NotificationCreate: 'notification.create',
} as const;
export type OutboxTopic = (typeof OutboxTopic)[keyof typeof OutboxTopic];

/** Top-level payload keys removed from every message when it reaches SENT or DEAD. */
export const OUTBOX_TERMINAL_SCRUB_KEYS: readonly string[] = ['codeCiphertext'];

// ─── email.otp ──────────────────────────────────────────────────────────────

export type OtpEmailTemplate = 'otp';

/**
 * Written only by `OtpMailer.enqueue()`. The worker loads the challenge (address, purpose, expiry,
 * name) itself — nothing else about the recipient lives in the outbox.
 */
export interface OtpEmailPayload {
  challengeId: string;
  /** base64url AES-256-GCM(OTP_OUTBOX_KEY, code, AAD = challengeId). Scrubbed once SENT/DEAD. */
  codeCiphertext: string;
  template: OtpEmailTemplate;
}

// ─── email.send ─────────────────────────────────────────────────────────────

export interface RegistrationAttemptEmailData {
  name?: string;
  /** e.g. `${APP_PUBLIC_URL}/login` and `/forgot-password` */
  loginUrl: string;
  resetUrl: string;
}
export interface EmailChangedNoticeData {
  name?: string;
  /** Masked new address, e.g. "j***@e***.com" (maskEmail). */
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

/** Templates deliverable through `email.send` (OTP emails are NOT among them: use OtpMailer). */
export interface EmailTemplateData {
  'registration-attempt-existing-account': RegistrationAttemptEmailData;
  'email-changed-notice': EmailChangedNoticeData;
  'reward-status': RewardStatusEmailData;
  'enrollment-status': EnrollmentStatusEmailData;
  generic: GenericEmailData;
}
export type EmailTemplateName = keyof EmailTemplateData;

/** Discriminated union: `{ to, template: 'generic', data: GenericEmailData }` etc. */
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
  /** No `code`/`otp` keys (DB CHECK) — e.g. use `programCode`. */
  data?: Record<string, unknown>;
}

export interface OutboxPayloads {
  'email.send': EmailSendPayload;
  'email.otp': OtpEmailPayload;
  'notification.create': NotificationCreatePayload;
}
