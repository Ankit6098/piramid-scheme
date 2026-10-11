import { ChallengePurpose } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { maskEmail } from '../../common/audit/mask';
import { smtpError } from './email.handler';
import { escapeHtml, isEmailTemplateName, renderEmail, renderOtpEmail } from './templates';

const ctx = { appName: 'Referral Platform', appUrl: 'http://localhost:8080' };

describe('email templates', () => {
  it('renders purpose-specific OTP copy with the code in text and html', () => {
    const subjects = new Set<string>();
    for (const purpose of ChallengePurpose) {
      const r = renderOtpEmail({ code: '482913', purpose, expiresInMinutes: 10, name: 'Ada' }, ctx);
      subjects.add(r.subject);
      expect(r.text).toContain('482913');
      expect(r.html).toContain('482913');
      expect(r.text).toContain('10 minutes');
    }
    expect(subjects.size).toBe(ChallengePurpose.length);
  });

  it('never greets a verification email by the (unverified) registration name', () => {
    const injected = 'Ada. URGENT: your account is locked, call +1 555 0100 or visit evil.example';
    const verify = renderOtpEmail({ code: '482913', purpose: 'EMAIL_VERIFICATION', expiresInMinutes: 10, name: injected }, ctx);
    expect(verify.text).not.toContain('URGENT');
    expect(verify.html).not.toContain('URGENT');
    expect(verify.text.startsWith('Hi,')).toBe(true);
    // existing accounts are still greeted by their name
    expect(renderOtpEmail({ code: '482913', purpose: 'PASSWORD_RESET', expiresInMinutes: 10, name: 'Ada' }, ctx).text).toContain('Hi Ada,');
  });

  it('escapes user-controlled values in HTML', () => {
    const r = renderEmail('generic', { subject: 'Hi', paragraphs: ['<script>alert(1)</script>'], actionLabel: 'Go', actionUrl: 'https://x.test/?a=1&b="2"' }, ctx);
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;');
    expect(r.html).toContain('a=1&amp;b=&quot;2&quot;');
    expect(escapeHtml(`'`)).toBe('&#39;');
  });

  it('renders every template', () => {
    expect(renderEmail('registration-attempt-existing-account', { loginUrl: 'u/login', resetUrl: 'u/reset' }, ctx).text).toContain('u/reset');
    expect(renderEmail('email-changed-notice', { newEmailMasked: 'j***@example.com' }, ctx).text).toContain('j***@example.com');
    expect(renderEmail('reward-status', { programName: 'Spring', status: 'POSTED', amountFormatted: '₹1,500.00' }, ctx).text).toContain('₹1,500.00');
    expect(renderEmail('enrollment-status', { programName: 'Spring', status: 'ACTIVE', optionName: 'Yearly' }, ctx).text).toContain('Spring (Yearly) is now active');
    expect(isEmailTemplateName('generic')).toBe(true);
    // OTP emails cannot go through email.send (codes never sit in plaintext in the outbox)
    expect(isEmailTemplateName('otp')).toBe(false);
    expect(isEmailTemplateName('nope')).toBe(false);
  });

  it('masks emails for logs and keeps SMTP errors free of addresses', () => {
    expect(maskEmail('jane.doe@example.com')).toBe('j***@e***.com');
    expect(maskEmail('x')).toBe('***');
    const err = smtpError(Object.assign(new Error('550 5.1.1 <jane@example.com>: Recipient address rejected'), { code: 'EENVELOPE', responseCode: 550 }));
    expect(err.message).toBe('SMTP delivery failed (EENVELOPE 550)');
    expect(smtpError('boom').message).toBe('SMTP delivery failed');
  });
});
