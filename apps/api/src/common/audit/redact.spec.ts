import { describe, expect, it } from 'vitest';
import { FORBIDDEN_AUDIT_KEYS, redactForAudit } from './redact';

describe('redactForAudit', () => {
  it('strips forbidden keys at any depth (case-insensitive), including inside arrays', () => {
    const input = {
      email: 'a@example.com',
      password: 'p',
      passwordHash: 'h',
      PasswordHash: 'H',
      profile: { token: 't', tokenHash: 'th', name: 'Ada', deeper: { codeHash: 'c', otp: '123456', keep: true } },
      challenges: [{ code: '123456', purpose: 'LOGIN_MFA' }],
    };
    expect(redactForAudit(input)).toEqual({
      email: 'a@example.com',
      profile: { name: 'Ada', deeper: { keep: true } },
      challenges: [{ purpose: 'LOGIN_MFA' }],
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

  it('covers the required keys', () => {
    for (const k of ['password', 'passwordHash', 'code', 'codeHash', 'token', 'tokenHash', 'otp']) {
      expect(FORBIDDEN_AUDIT_KEYS).toContain(k);
    }
  });
});
