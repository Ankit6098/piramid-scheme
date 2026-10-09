import { ChallengePurpose } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { scrubEmailPayload } from './email.handler';
import { maskEmail } from './email.service';
import { escapeHtml, isEmailTemplateName, renderEmail } from './templates';

const ctx = { appName: 'Referral Platform', appUrl: 'http://localhost:8080' };

describe('email templates', () => {
  it('renders purpose-specific OTP copy with the code in text and html', () => {
    const subjects = new Set<string>();
    for (const purpose of ChallengePurpose) {
      const r = renderEmail('otp', { code: '482913', purpose, expiresInMinutes: 10, name: 'Ada' }, ctx);
      subjects.add(r.subject);
      expect(r.text).toContain('482913');
      expect(r.html).toContain('482913');
      expect(r.text).toContain('10 minutes');
    }
    expect(subjects.size).toBe(ChallengePurpose.length);
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
    expect(isEmailTemplateName('otp')).toBe(true);
    expect(isEmailTemplateName('nope')).toBe(false);
  });

  it('scrubs OTP codes from delivered payloads and masks emails for logs', () => {
    const scrubbed = scrubEmailPayload({ to: 'a@b.c', template: 'otp', data: { code: '123456', purpose: 'PASSWORD_RESET', expiresInMinutes: 10 } });
    expect(JSON.stringify(scrubbed)).not.toContain('123456');
    const generic = { to: 'a@b.c', template: 'generic' as const, data: { subject: 's', paragraphs: [] } };
    expect(scrubEmailPayload(generic)).toBe(generic);
    expect(maskEmail('jane.doe@example.com')).toBe('ja***@example.com');
    expect(maskEmail('x')).toBe('***');
  });
});
