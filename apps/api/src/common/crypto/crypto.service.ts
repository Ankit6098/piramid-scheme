import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../config/app-config';
import { aesGcmDecrypt, aesGcmDecryptFromString, aesGcmEncrypt, aesGcmEncryptToString, parseAesKey } from './aes-gcm';
import { emailHmac, otpCodeHash } from './hmac';

/** AAD binding an encrypted TOTP secret to its owner (a secret copied to another user fails to decrypt). */
export function totpSecretAad(userId: string): string {
  return `user_mfa_factors:${userId}`;
}

/**
 * Application-level encryption & keyed hashing with the configured secrets:
 * - OTP codes in outbox payloads: AES-256-GCM with `OTP_OUTBOX_KEY`, AAD = challenge id.
 * - TOTP secrets at rest (`user_mfa_factors.secret_enc`): AES-256-GCM with `MFA_ENCRYPTION_KEY`,
 *   AAD = `totpSecretAad(userId)`.
 * - OTP code hashes / email HMACs with `OTP_PEPPER`.
 * Keys are parsed once; nothing here ever logs plaintext.
 */
@Injectable()
export class CryptoService {
  private readonly otpKey: Buffer;
  private readonly mfaKey: Buffer;
  private readonly pepper: string;

  constructor(config: AppConfig) {
    this.otpKey = parseAesKey(config.security.otpOutboxKeyHex, 'OTP_OUTBOX_KEY');
    this.mfaKey = parseAesKey(config.security.mfaEncryptionKeyHex, 'MFA_ENCRYPTION_KEY');
    this.pepper = config.security.otpPepper;
  }

  /** base64url ciphertext of an OTP code for an outbox payload (`codeCiphertext`). */
  encryptOtpCode(code: string, challengeId: string): string {
    return aesGcmEncryptToString(this.otpKey, code, challengeId);
  }

  /** Throws `DecryptionError` when the ciphertext does not belong to this challenge or was tampered with. */
  decryptOtpCode(ciphertext: string, challengeId: string): string {
    return aesGcmDecryptFromString(this.otpKey, ciphertext, challengeId);
  }

  /** Encrypts a base32 TOTP secret for `user_mfa_factors.secret_enc`. */
  encryptTotpSecret(secretBase32: string, userId: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(aesGcmEncrypt(this.mfaKey, secretBase32, totpSecretAad(userId)));
  }

  /** Returns the base32 TOTP secret. Throws `DecryptionError` on a wrong key/user or tampering. */
  decryptTotpSecret(secretEnc: Uint8Array, userId: string): string {
    return aesGcmDecrypt(this.mfaKey, secretEnc, totpSecretAad(userId)).toString('utf8');
  }

  /** `email_challenges.code_hash` for (purpose, email, code) — see `otpCodeHash()`. */
  otpCodeHash(purpose: string, email: string, code: string): string {
    return otpCodeHash(this.pepper, purpose, email, code);
  }

  /** Keyed pseudonym of an email (rate-limit keys); domain-separated per use. */
  emailHmac(email: string, domain?: string): string {
    return emailHmac(this.pepper, email, domain);
  }
}
