import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM with associated data (AAD).
 *
 * Binary layout (`SealedBox`): `[version:1][iv:12][tag:16][ciphertext:n]`, version = 0x01.
 * The AAD is NOT stored: the caller must supply the same context string to decrypt (e.g. the OTP
 * challenge id, or `totp:<userId>`), which binds a ciphertext to the row it belongs to — a
 * ciphertext copied to another row fails authentication.
 */
export const AES_GCM_VERSION = 0x01;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

/** Thrown when a ciphertext is malformed, was produced with another key/AAD, or was tampered with. */
export class DecryptionError extends Error {
  constructor(message = 'Decryption failed') {
    super(message);
    this.name = 'DecryptionError';
  }
}

/** Parses a 32-byte key given as 64 hex characters. */
export function parseAesKey(hex: string, name = 'key'): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${name} must be 64 hex characters (32 bytes)`);
  return Buffer.from(hex, 'hex');
}

function assertKey(key: Buffer): void {
  if (key.length !== 32) throw new Error('AES-256-GCM needs a 32-byte key');
}

/** Encrypts `plaintext` and returns the sealed box (version | iv | tag | ciphertext). */
export function aesGcmEncrypt(key: Buffer, plaintext: string | Buffer, aad: string): Buffer {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([AES_GCM_VERSION]), iv, cipher.getAuthTag(), ct]);
}

/** Decrypts a sealed box. Throws `DecryptionError` on any failure (never returns partial data). */
export function aesGcmDecrypt(key: Buffer, sealed: Uint8Array, aad: string): Buffer {
  assertKey(key);
  const box = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  if (box.length < HEADER_BYTES || box[0] !== AES_GCM_VERSION) throw new DecryptionError('Unsupported ciphertext format');
  const iv = box.subarray(1, 1 + IV_BYTES);
  const tag = box.subarray(1 + IV_BYTES, HEADER_BYTES);
  const ct = box.subarray(HEADER_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new DecryptionError();
  }
}

/** String form for JSON payloads: base64url of the sealed box. */
export function aesGcmEncryptToString(key: Buffer, plaintext: string, aad: string): string {
  return aesGcmEncrypt(key, plaintext, aad).toString('base64url');
}

export function aesGcmDecryptFromString(key: Buffer, encoded: string, aad: string): string {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new DecryptionError('Malformed ciphertext');
  return aesGcmDecrypt(key, Buffer.from(encoded, 'base64url'), aad).toString('utf8');
}
