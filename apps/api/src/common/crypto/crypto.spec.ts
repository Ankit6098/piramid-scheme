import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config/app-config';
import { aesGcmDecrypt, aesGcmDecryptFromString, aesGcmEncrypt, aesGcmEncryptToString, DecryptionError, parseAesKey } from './aes-gcm';
import { CryptoService, totpSecretAad } from './crypto.service';
import { emailHmac, hexDigestEquals, hmacSha256Hex, otpCodeHash } from './hmac';
import { constantTimeEqual, randomNumericCode } from './tokens';
import { base32Decode, base32Encode, buildOtpauthUri, generateTotpSecret, hotp, totp, totpStep, verifyTotp } from './totp';

const KEY = parseAesKey('11'.repeat(32));
const OTHER_KEY = parseAesKey('22'.repeat(32));

describe('AES-256-GCM', () => {
  it('round-trips with the same key and AAD, with a fresh IV each time', () => {
    const a = aesGcmEncrypt(KEY, '482913', 'challenge-1');
    const b = aesGcmEncrypt(KEY, '482913', 'challenge-1');
    expect(a.equals(b)).toBe(false);
    expect(a[0]).toBe(1);
    expect(a.length).toBe(1 + 12 + 16 + 6);
    expect(aesGcmDecrypt(KEY, a, 'challenge-1').toString()).toBe('482913');
  });

  it('rejects a wrong AAD, a wrong key and any tampering', () => {
    const box = aesGcmEncrypt(KEY, 'secret', 'aad-1');
    expect(() => aesGcmDecrypt(KEY, box, 'aad-2')).toThrow(DecryptionError);
    expect(() => aesGcmDecrypt(OTHER_KEY, box, 'aad-1')).toThrow(DecryptionError);
    for (const i of [0, 5, 20, box.length - 1]) {
      const t = Buffer.from(box);
      t[i] = t[i]! ^ 0x01;
      expect(() => aesGcmDecrypt(KEY, t, 'aad-1')).toThrow(DecryptionError);
    }
    expect(() => aesGcmDecrypt(KEY, box.subarray(0, 10), 'aad-1')).toThrow(DecryptionError);
  });

  it('string form is base64url and validates input', () => {
    const s = aesGcmEncryptToString(KEY, '123456', 'c');
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(aesGcmDecryptFromString(KEY, s, 'c')).toBe('123456');
    expect(() => aesGcmDecryptFromString(KEY, 'not base64!', 'c')).toThrow(DecryptionError);
  });

  it('parses only 32-byte hex keys', () => {
    expect(() => parseAesKey('abc')).toThrow(/64 hex/);
    expect(parseAesKey('Ab'.repeat(32))).toHaveLength(32);
  });
});

describe('HMAC helpers', () => {
  it('RFC 4231 test case 2', () => {
    expect(hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('otpCodeHash normalizes the email and binds purpose + code', () => {
    const h = otpCodeHash('pepper', 'LOGIN_MFA', ' Ada@Example.COM ', '123456');
    expect(h).toBe(hmacSha256Hex('pepper', 'LOGIN_MFA:ada@example.com:123456'));
    expect(h).not.toBe(otpCodeHash('pepper', 'PASSWORD_RESET', 'ada@example.com', '123456'));
    expect(emailHmac('pepper', 'A@B.c')).toBe(emailHmac('pepper', 'a@b.c'));
    expect(emailHmac('pepper', 'a@b.c')).not.toBe(emailHmac('pepper', 'a@b.c', 'other'));
  });

  it('constant-time comparisons', () => {
    expect(hexDigestEquals('ab'.repeat(32), 'AB'.repeat(32))).toBe(true);
    expect(hexDigestEquals('ab'.repeat(32), 'ac'.repeat(32))).toBe(false);
    expect(hexDigestEquals('ab', 'abab')).toBe(false);
    expect(hexDigestEquals('zz', 'zz')).toBe(false);
    expect(hexDigestEquals(null, 'ab')).toBe(false);
    expect(constantTimeEqual('x', 'x')).toBe(true);
    expect(constantTimeEqual('x', 'y')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(false);
  });

  it('randomNumericCode returns zero-padded digits', () => {
    for (let i = 0; i < 50; i++) expect(randomNumericCode()).toMatch(/^\d{6}$/);
    expect(randomNumericCode(8)).toMatch(/^\d{8}$/);
  });
});

describe('Base32 (RFC 4648 §10 vectors, unpadded)', () => {
  const vectors: Array<[string, string]> = [
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];
  it.each(vectors)('%j ↔ %s', (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain))).toBe(encoded);
    expect(base32Decode(encoded).toString()).toBe(plain);
  });

  it('decodes leniently (case, padding, spaces) and rejects invalid characters', () => {
    expect(base32Decode('mzxw 6ytb oi======').toString()).toBe('foobar');
    expect(() => base32Decode('MZ1W')).toThrow(/base32/);
  });

  it('generates 160-bit secrets', () => {
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(s);
  });
});

// RFC 4226 Appendix D / RFC 6238 Appendix B (SHA-1 seed "12345678901234567890").
const SEED = Buffer.from('12345678901234567890', 'ascii');
const SEED_B32 = base32Encode(SEED);

describe('HOTP (RFC 4226 Appendix D)', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  it.each(expected.map((code, counter) => [counter, code] as const))('counter %i → %s', (counter, code) => {
    expect(hotp(SEED, counter)).toBe(code);
    expect(hotp(SEED_B32, BigInt(counter))).toBe(code);
  });
});

describe('TOTP (RFC 6238 Appendix B, SHA-1)', () => {
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  it.each(vectors)('T=%i → %s (8 digits) and its 6-digit suffix', (seconds, code) => {
    expect(totp(SEED, seconds * 1000, { digits: 8 })).toBe(code);
    expect(totp(SEED_B32, seconds * 1000)).toBe(code.slice(-6));
  });

  it('verifies within ±1 step and returns the matched step', () => {
    const now = 1111111111_000;
    const step = totpStep(now);
    expect(verifyTotp(SEED_B32, totp(SEED, now), { now })).toEqual({ ok: true, step });
    expect(verifyTotp(SEED_B32, totp(SEED, now - 30_000), { now })).toEqual({ ok: true, step: step - 1 });
    expect(verifyTotp(SEED_B32, totp(SEED, now + 30_000), { now })).toEqual({ ok: true, step: step + 1 });
    expect(verifyTotp(SEED_B32, totp(SEED, now - 60_000), { now })).toEqual({ ok: false, reason: 'invalid' });
    expect(verifyTotp(SEED_B32, totp(SEED, now + 60_000), { now, window: 2 })).toEqual({ ok: true, step: step + 2 });
    expect(verifyTotp(SEED_B32, ` ${totp(SEED, now).slice(0, 3)} ${totp(SEED, now).slice(3)} `, { now }).ok).toBe(true);
  });

  it('rejects replays of the last used step (and older steps)', () => {
    const now = 1234567890_000;
    const step = totpStep(now);
    const code = totp(SEED, now);
    expect(verifyTotp(SEED, code, { now, lastUsedStep: step })).toEqual({ ok: false, reason: 'replayed' });
    expect(verifyTotp(SEED, code, { now, lastUsedStep: BigInt(step - 1) })).toEqual({ ok: true, step });
    expect(verifyTotp(SEED, totp(SEED, now - 30_000), { now, lastUsedStep: step })).toEqual({ ok: false, reason: 'replayed' });
  });

  it('rejects malformed codes', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 5']) {
      expect(verifyTotp(SEED, bad)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('builds an otpauth:// URI', () => {
    const uri = buildOtpauthUri({ secret: 'JBSWY3DPEHPK3PXP', accountName: 'ada@example.com', issuer: 'Referral Platform' });
    expect(uri).toBe(
      'otpauth://totp/Referral%20Platform:ada%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Referral%20Platform&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('CryptoService', () => {
  const config = {
    security: { otpOutboxKeyHex: '33'.repeat(32), mfaEncryptionKeyHex: '44'.repeat(32), otpPepper: 'p'.repeat(64) },
  } as unknown as AppConfig;
  const svc = new CryptoService(config);

  it('encrypts OTP codes bound to their challenge id', () => {
    const ct = svc.encryptOtpCode('654321', 'challenge-a');
    expect(ct).not.toContain('654321');
    expect(svc.decryptOtpCode(ct, 'challenge-a')).toBe('654321');
    expect(() => svc.decryptOtpCode(ct, 'challenge-b')).toThrow(DecryptionError);
  });

  it('encrypts TOTP secrets bound to their user (and with a different key than OTPs)', () => {
    const secret = generateTotpSecret();
    const enc = svc.encryptTotpSecret(secret, 'user-1');
    expect(enc).toBeInstanceOf(Uint8Array);
    expect(svc.decryptTotpSecret(enc, 'user-1')).toBe(secret);
    expect(() => svc.decryptTotpSecret(enc, 'user-2')).toThrow(DecryptionError);
    expect(totpSecretAad('u')).toBe('user_mfa_factors:u');
    const otpCt = svc.encryptOtpCode('123456', 'user_mfa_factors:user-1');
    expect(() => svc.decryptTotpSecret(Buffer.from(otpCt, 'base64url'), 'user-1')).toThrow(DecryptionError);
  });

  it('hashes OTP codes with the pepper', () => {
    expect(svc.otpCodeHash('LOGIN_MFA', 'a@b.c', '123456')).toBe(otpCodeHash('p'.repeat(64), 'LOGIN_MFA', 'a@b.c', '123456'));
  });
});
