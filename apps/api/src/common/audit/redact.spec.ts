import { describe, expect, it } from 'vitest';
import { maskEmail, maskPhone } from './mask';
import { FORBIDDEN_AUDIT_KEYS, isForbiddenAuditKey, redactForAudit } from './redact';

/** The audit CHECK constraint of the integrity migration, verbatim (case-insensitive). */
const DB_CHECK =
  /"(password|password_?hash|token|token_?hash|otp|otp_?code|code_?hash|secret|secret_?enc|session_?token|csrf_?token|api_?key|key_?hash|code_?ciphertext)"\s*:/i;

describe('redactForAudit', () => {
  it('strips forbidden keys at any depth (case-insensitive), including inside arrays', () => {
    const input = {
      name: 'Ada',
      password: 'p',
      passwordHash: 'h',
      PasswordHash: 'H',
      password_hash: 'h2',
      profile: { token: 't', tokenHash: 'th', name: 'Ada', deeper: { codeHash: 'c', otp: '123456', keep: true } },
      challenges: [{ codeCiphertext: 'x', secretEnc: 'y', purpose: 'LOGIN_MFA' }],
      client: { apiKey: 'k', keyHash: 'kh', csrfToken: 'c', secret: 's', keyPrefix: 'abc' },
    };
    expect(redactForAudit(input)).toEqual({
      name: 'Ada',
      profile: { name: 'Ada', deeper: { keep: true } },
      challenges: [{ purpose: 'LOGIN_MFA' }],
      client: { keyPrefix: 'abc' },
    });
  });

  it('keeps plain `code` fields (program / referral codes)', () => {
    expect(redactForAudit({ code: 'spring-2027', referralCode: 'ANITA234', programCode: 'p1' })).toEqual({
      code: 'spring-2027',
      referralCode: 'ANITA234',
      programCode: 'p1',
    });
  });

  it('masks emails and phones', () => {
    expect(redactForAudit({ email: 'anita@example.com', newEmail: 'Bob@Mail.org', phone: '+919876543210', note: 'x' })).toEqual({
      email: 'a***@e***.com',
      newEmail: 'B***@M***.org',
      phone: '+**********10',
      note: 'x',
    });
  });

  it('normalizes bigint and Date to JSON-safe values and drops undefined', () => {
    const at = new Date('2026-10-10T00:00:00.000Z');
    expect(redactForAudit({ amountMinor: 150000n, at, missing: undefined, list: [1n, null] })).toEqual({
      amountMinor: '150000',
      at: '2026-10-10T00:00:00.000Z',
      list: ['1', null],
    });
  });

  it('does not mutate its input', () => {
    const input = { password: 'x', nested: { token: 'y' } };
    redactForAudit(input);
    expect(input).toEqual({ password: 'x', nested: { token: 'y' } });
  });

  it('never produces JSON the DB CHECK would reject', () => {
    const keys = [...FORBIDDEN_AUDIT_KEYS, 'PASSWORD', 'Token_Hash', 'session_token', 'otp_code', 'code_ciphertext', 'secret_enc', 'api_key'];
    const input = Object.fromEntries(keys.map((k) => [k, 'v']));
    const json = JSON.stringify(redactForAudit({ ...input, nested: [{ ...input }] }));
    expect(json).not.toMatch(DB_CHECK);
    for (const k of keys) expect(isForbiddenAuditKey(k)).toBe(true);
    for (const k of ['code', 'name', 'status', 'amountMinor', 'keyPrefix']) expect(isForbiddenAuditKey(k)).toBe(false);
  });
});

describe('maskEmail / maskPhone', () => {
  it('masks emails as first letter + *** for local part and domain, keeping the TLD', () => {
    expect(maskEmail('anita@example.com')).toBe('a***@e***.com');
    expect(maskEmail('jo@mail.example.co.uk')).toBe('j***@m***.uk');
    expect(maskEmail('x@localhost')).toBe('x***@l***');
    expect(maskEmail('not-an-email')).toBe('***');
    expect(maskEmail('@example.com')).toBe('***');
    expect(maskEmail(null)).toBe('***');
  });

  it('masks phones keeping the + and the last two digits', () => {
    expect(maskPhone('+91 98765 43210')).toBe('+**********10');
    expect(maskPhone('9876543210')).toBe('********10');
    expect(maskPhone('12')).toBe('***');
    expect(maskPhone(undefined)).toBe('***');
  });
});
