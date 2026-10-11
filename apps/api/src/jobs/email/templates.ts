import type { ChallengePurpose } from '@app/shared';
import type {
  EmailChangedNoticeData,
  EmailTemplateData,
  EmailTemplateName,
  EnrollmentStatusEmailData,
  GenericEmailData,
  RegistrationAttemptEmailData,
  RewardStatusEmailData,
} from '../../common/outbox/outbox.topics';

/**
 * Render input of the OTP email. Built by the `email.otp` worker from the challenge row and the
 * decrypted code — it is never stored in an outbox payload.
 */
export interface OtpEmailData {
  code: string;
  purpose: ChallengePurpose;
  expiresInMinutes: number;
  name?: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface TemplateContext {
  appName: string;
  appUrl: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function greeting(name?: string): string {
  return name ? `Hi ${name},` : 'Hi,';
}

/** A paragraph of plain text, or a highlighted one-time code. */
type Block = string | { code: string };

function layout(ctx: TemplateContext, blocks: Block[], action?: { label: string; url: string }): string {
  const body = blocks
    .map((b) =>
      typeof b === 'string'
        ? `<p style="margin:0 0 16px">${escapeHtml(b)}</p>`
        : `<p style="font-size:28px;letter-spacing:6px;font-weight:700;margin:8px 0 24px;font-family:monospace">${escapeHtml(b.code)}</p>`,
    )
    .join('');
  const button = action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="background:#111827;color:#ffffff;padding:10px 18px;border-radius:6px;text-decoration:none">${escapeHtml(action.label)}</a></p>`
    : '';
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#111827;line-height:1.5;max-width:560px;margin:0 auto;padding:24px">${body}${button}<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0"><p style="color:#6b7280;font-size:12px">${escapeHtml(ctx.appName)} · ${escapeHtml(ctx.appUrl)}</p></body></html>`;
}

function text(paragraphs: string[], ctx: TemplateContext, extra: string[] = []): string {
  return [...paragraphs, ...extra, '', `— ${ctx.appName} (${ctx.appUrl})`].join('\n\n');
}

const OTP_COPY: Record<ChallengePurpose, { subject: string; intro: string; outro: string }> = {
  EMAIL_VERIFICATION: {
    subject: 'Verify your email address',
    intro: 'Use this code to verify your email address and activate your account:',
    outro: "If you didn't create an account, you can ignore this email.",
  },
  LOGIN_MFA: {
    subject: 'Your sign-in verification code',
    intro: 'Use this code to finish signing in to the admin area:',
    outro: "If you didn't try to sign in, change your password immediately.",
  },
  PASSWORD_RESET: {
    subject: 'Reset your password',
    intro: 'Use this code to reset your password:',
    outro: "If you didn't request a password reset, you can ignore this email — your password is unchanged.",
  },
  EMAIL_CHANGE: {
    subject: 'Confirm your new email address',
    intro: 'Use this code to confirm this address as your new sign-in email:',
    outro: "If you didn't request this change, ignore this email and review your account security.",
  },
};

/**
 * EMAIL_VERIFICATION codes are sent before any account exists: the only name available is what the
 * registrant typed for this address, so they never greet by name (no attacker-chosen text in mail
 * that an unrelated mailbox owner receives).
 */
export function renderOtpEmail(data: OtpEmailData, ctx: TemplateContext): RenderedEmail {
  const copy = OTP_COPY[data.purpose];
  const name = data.purpose === 'EMAIL_VERIFICATION' ? undefined : data.name;
  const validity = `The code expires in ${data.expiresInMinutes} minutes and can be used once. Never share it with anyone.`;
  return {
    subject: `${copy.subject} — ${ctx.appName}`,
    text: text([greeting(name), copy.intro, data.code, validity, copy.outro], ctx),
    html: layout(ctx, [greeting(name), copy.intro, { code: data.code }, validity, copy.outro]),
  };
}

export function registrationAttemptEmail(data: RegistrationAttemptEmailData, ctx: TemplateContext): RenderedEmail {
  const paragraphs = [
    greeting(data.name),
    'Someone tried to create a new account with this email address. An account already exists for it, so no new account was created.',
    'If this was you, sign in instead. If you forgot your password, you can reset it.',
    "If it wasn't you, no action is needed.",
  ];
  return {
    subject: `Sign-in attempt for your account — ${ctx.appName}`,
    text: text(paragraphs, ctx, [`Sign in: ${data.loginUrl}`, `Reset password: ${data.resetUrl}`]),
    html: layout(ctx, paragraphs, { label: 'Sign in', url: data.loginUrl }),
  };
}

export function emailChangedNotice(data: EmailChangedNoticeData, ctx: TemplateContext): RenderedEmail {
  const paragraphs = [
    greeting(data.name),
    `The sign-in email for your account was changed to ${data.newEmailMasked}. This address will no longer receive account emails.`,
    "If you didn't make this change, contact support immediately.",
  ];
  return {
    subject: `Your account email was changed — ${ctx.appName}`,
    text: text(paragraphs, ctx, data.supportUrl ? [`Support: ${data.supportUrl}`] : []),
    html: layout(ctx, paragraphs, data.supportUrl ? { label: 'Contact support', url: data.supportUrl } : undefined),
  };
}

const REWARD_STATUS_COPY: Record<RewardStatusEmailData['status'], string> = {
  PENDING_APPROVAL: 'is pending review',
  APPROVED: 'was approved',
  POSTED: 'was approved and added to your earnings',
  REJECTED: 'was not approved',
  REVERSED: 'was reversed',
};

export function rewardStatusEmail(data: RewardStatusEmailData, ctx: TemplateContext): RenderedEmail {
  const paragraphs = [
    greeting(data.name),
    `Your reward of ${data.amountFormatted} in ${data.programName} ${REWARD_STATUS_COPY[data.status]}.`,
    ...(data.reason ? [`Reason: ${data.reason}`] : []),
  ];
  return {
    subject: `Reward update: ${data.programName} — ${ctx.appName}`,
    text: text(paragraphs, ctx, data.url ? [`Details: ${data.url}`] : []),
    html: layout(ctx, paragraphs, data.url ? { label: 'View rewards', url: data.url } : undefined),
  };
}

const ENROLLMENT_STATUS_COPY: Record<EnrollmentStatusEmailData['status'], string> = {
  PENDING: 'has been received and is pending activation',
  ACTIVE: 'is now active',
  CANCELLED: 'was cancelled',
  EXPIRED: 'has expired',
  REJECTED: 'was not approved',
};

export function enrollmentStatusEmail(data: EnrollmentStatusEmailData, ctx: TemplateContext): RenderedEmail {
  const what = data.optionName ? `${data.programName} (${data.optionName})` : data.programName;
  const paragraphs = [
    greeting(data.name),
    `Your enrollment in ${what} ${ENROLLMENT_STATUS_COPY[data.status]}.`,
    ...(data.reason ? [`Reason: ${data.reason}`] : []),
  ];
  return {
    subject: `Enrollment update: ${data.programName} — ${ctx.appName}`,
    text: text(paragraphs, ctx, data.url ? [`Details: ${data.url}`] : []),
    html: layout(ctx, paragraphs, data.url ? { label: 'View enrollment', url: data.url } : undefined),
  };
}

export function genericEmail(data: GenericEmailData, ctx: TemplateContext): RenderedEmail {
  const action = data.actionLabel && data.actionUrl ? { label: data.actionLabel, url: data.actionUrl } : undefined;
  return {
    subject: data.subject,
    text: text(data.paragraphs, ctx, action ? [`${action.label}: ${action.url}`] : []),
    html: layout(ctx, data.paragraphs, action),
  };
}

type Renderers = { [K in EmailTemplateName]: (data: EmailTemplateData[K], ctx: TemplateContext) => RenderedEmail };

export const EMAIL_TEMPLATES: Renderers = {
  'registration-attempt-existing-account': registrationAttemptEmail,
  'email-changed-notice': emailChangedNotice,
  'reward-status': rewardStatusEmail,
  'enrollment-status': enrollmentStatusEmail,
  generic: genericEmail,
};

export function isEmailTemplateName(name: string): name is EmailTemplateName {
  return Object.prototype.hasOwnProperty.call(EMAIL_TEMPLATES, name);
}

export function renderEmail<K extends EmailTemplateName>(template: K, data: EmailTemplateData[K], ctx: TemplateContext): RenderedEmail {
  return (EMAIL_TEMPLATES[template] as (d: EmailTemplateData[K], c: TemplateContext) => RenderedEmail)(data, ctx);
}
