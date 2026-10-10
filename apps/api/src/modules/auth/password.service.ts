import { Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomToken } from '../../common/crypto/tokens';

/** argon2id with the library defaults (m = 64 MiB, t = 3, p = 4) — the same as the seed. */
const ARGON2_OPTIONS = { type: argon2.argon2id } as const;

/**
 * Password hashing (business rules §2: argon2id). `verifyDummy` spends the same time as a real
 * verification so unknown emails and wrong passwords are indistinguishable by timing.
 */
@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);
  private dummyHash: Promise<string> | null = null;

  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  /** False for a wrong password or a malformed/missing hash (never throws). */
  async verify(hash: string | null | undefined, password: string): Promise<boolean> {
    if (!hash) {
      await this.verifyDummy(password);
      return false;
    }
    try {
      return await argon2.verify(hash, password);
    } catch (err) {
      this.logger.warn({ err: { name: (err as Error)?.name } }, 'Password hash could not be verified');
      return false;
    }
  }

  /** Burns one argon2 verification against a random hash (equal timing for unknown accounts). */
  async verifyDummy(password: string): Promise<void> {
    this.dummyHash ??= argon2.hash(randomToken(24), ARGON2_OPTIONS);
    try {
      await argon2.verify(await this.dummyHash, password);
    } catch {
      // ignored — only the time spent matters
    }
  }

  /** True when the stored hash uses weaker parameters than today's (rehash after a successful login). */
  needsRehash(hash: string): boolean {
    try {
      // Library defaults are the target parameters; an argon2i/argon2d hash also counts as outdated.
      return !hash.startsWith('$argon2id$') || argon2.needsRehash(hash);
    } catch {
      return false;
    }
  }
}
