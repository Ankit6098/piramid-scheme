import { Injectable, Logger } from '@nestjs/common';
import { rateLimited } from '../../common/errors/app-error';
import { RedisService } from '../../common/redis/redis.service';
import { TOTP_LOCKOUT_POLICY, type TotpLockoutPolicy } from './domain/totp-lockout';

export interface TotpFailureResult {
  /** Consecutive failures of this account inside the window. */
  failures: number;
  /** Set when this failure (re)started a lock. */
  lockedForSeconds: number | null;
  /** True exactly once per lock episode: the failure that reached the threshold. */
  firstLock: boolean;
}

/**
 * KEYS: count, block. ARGV: windowMs, threshold, baseMs, maxMs. Returns { failures, blockMs }.
 * The counter outlives a lock by `windowMs`, so the first wrong code after a lock ends re-locks
 * (with a doubled duration) instead of granting another `threshold` free guesses.
 */
const RECORD_FAILURE = `
local n = redis.call('INCR', KEYS[1])
local window = tonumber(ARGV[1])
local threshold = tonumber(ARGV[2])
local block = 0
if n >= threshold then
  local exp = n - threshold
  if exp > 30 then exp = 30 end
  block = math.floor(tonumber(ARGV[3]) * (2 ^ exp))
  if block > tonumber(ARGV[4]) then block = tonumber(ARGV[4]) end
  if redis.call('PTTL', KEYS[2]) < block then
    redis.call('SET', KEYS[2], '1', 'PX', block)
  end
end
redis.call('PEXPIRE', KEYS[1], window + block)
return { n, block }
`;

/**
 * Per-ACCOUNT authenticator guess limit (see `domain/totp-lockout.ts`), independent of the client IP,
 * shared by /auth/mfa/totp/verify, /auth/mfa/totp/confirm and /users/me/mfa/totp/reset. Kept in
 * Redis next to the login backoff; like it, a Redis outage fails open (logged) — the per-(user, IP)
 * and per-IP backoff and the route throttler still apply.
 */
@Injectable()
export class TotpLockoutService {
  private readonly logger = new Logger(TotpLockoutService.name);
  private readonly prefix = 'totp-lockout:v1:user:';
  readonly policy: TotpLockoutPolicy = TOTP_LOCKOUT_POLICY;

  constructor(private readonly redis: RedisService) {}

  private keys(userId: string) {
    return { count: `${this.prefix}${userId}:n`, block: `${this.prefix}${userId}:block` };
  }

  /** Throws 429 RATE_LIMITED (`details.retryAfterSeconds`) while the account's TOTP verification is paused. */
  async assertNotLocked(userId: string): Promise<void> {
    let ttl = 0;
    try {
      ttl = await this.redis.redis.pttl(this.keys(userId).block);
    } catch (err) {
      this.logger.warn({ err }, 'TOTP lockout check failed (Redis); allowing');
      return;
    }
    if (ttl > 0) throw totpLocked(Math.max(1, Math.ceil(ttl / 1000)));
  }

  async recordFailure(userId: string): Promise<TotpFailureResult> {
    const k = this.keys(userId);
    const p = this.policy;
    try {
      const [failures, blockMs] = (await this.redis.redis.eval(
        RECORD_FAILURE,
        2,
        k.count,
        k.block,
        String(p.windowMs),
        String(p.threshold),
        String(p.baseMs),
        String(p.maxMs),
      )) as [number, number];
      return {
        failures,
        lockedForSeconds: blockMs > 0 ? Math.ceil(blockMs / 1000) : null,
        firstLock: failures === p.threshold,
      };
    } catch (err) {
      this.logger.warn({ err }, 'TOTP lockout recordFailure failed (Redis)');
      return { failures: 0, lockedForSeconds: null, firstLock: false };
    }
  }

  /** A correct code: the consecutive-failure counter starts over. */
  async reset(userId: string): Promise<void> {
    const k = this.keys(userId);
    try {
      await this.redis.redis.del(k.count, k.block);
    } catch (err) {
      this.logger.warn({ err }, 'TOTP lockout reset failed (Redis)');
    }
  }
}

export function totpLocked(retryAfterSeconds: number) {
  return rateLimited('Too many incorrect authenticator codes. Verification is paused for this account; please try again later', {
    retryAfterSeconds,
  });
}
