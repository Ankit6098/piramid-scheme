/**
 * PII masking for audit entries and logs (business rules §13).
 *   maskEmail('anita@example.com')  → 'a***@e***.com'
 *   maskEmail('jo@mail.example.co.uk') → 'j***@m***.uk'
 *   maskPhone('+91 98765 43210')     → '+**********10'
 */
export function maskEmail(email: string | null | undefined): string {
  if (typeof email !== 'string') return '***';
  const value = email.trim();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return '***';
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const tld = dot > 0 && dot < domain.length - 1 ? domain.slice(dot + 1) : '';
  const domainHead = domain[0] ?? '';
  return `${local[0]}***@${domainHead}***${tld ? `.${tld}` : ''}`;
}

/** Keeps a leading '+' and the last two digits; every other digit becomes '*'. */
export function maskPhone(phone: string | null | undefined): string {
  if (typeof phone !== 'string') return '***';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  const plus = phone.trim().startsWith('+') ? '+' : '';
  return `${plus}${'*'.repeat(digits.length - 2)}${digits.slice(-2)}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

/** True for strings that look like an email address (used by audit auto-masking). */
export function looksLikeEmail(value: unknown): value is string {
  return typeof value === 'string' && EMAIL_RE.test(value.trim()) && !value.includes('***');
}
