import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../config/app-config';
import { CryptoService } from '../crypto/crypto.service';
import { rateLimited } from '../errors/app-error';
import { RedisService } from '../redis/redis.service';

export interface LoginThrottlePolicy {
  /** Failures per (email-HMAC, IP) before the first block. */
  freeAttempts: number;
  /** Failures per IP (any email) before the first block. */
  ipFreeAttempts: number;
  /** First block duration; doubles with every further failure… */
  baseMs: number;
  /** …up to this cap. */
  maxMs: number;
  /** Failure counters expire after this long without a new failure. */
  windowMs: number;
}

export type LoginThrottleDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; scope: 'account' | 'ip' };

export interface LoginFailureResult {
  /** Failures recorded for this (email, IP) pair / this IP inside the window. */
  failures: number;
  ipFailures: number;
  /** Set when this failure started (or extended) a block. */
  retryAfterSeconds: number | null;
}

/**
 * Block duration after `failures` failures: 0 below `free`, then base·2^(failures − free) capped at
 * max. Defaults: 5th failure → 30 s, 6th → 60 s, … → 15 min.
 */
export function loginBackoffMs(failures: number, free: number, baseMs: number, maxMs: number): number {
  if (failures < free) return 0;
  const exp = Math.min(30, failures - free);
  return Math.min(maxMs, baseMs * 2 ** exp);
}

/**
 * Normalizes a client IP for keys: IPv4-mapped IPv6 → IPv4; IPv6 → its /64 prefix (one subscriber
 * usually owns a whole /64); missing → 'unknown'.
 */
export function normalizeThrottleIp(ip: string | null | undefined): string {
  if (!ip) return 'unknown';
  let v = ip.trim().toLowerCase();
  if (v.startsWith('::ffff:') && v.includes('.')) v = v.slice(7);
  if (!v.includes(':')) return v;
  const [head = '', tail = ''] = v.split('::');
  const h = head ? head.split(':') : [];
  const t = v.includes('::') && tail ? tail.split(':') : [];
  const groups = v.includes('::') ? [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : v.split(':');
  return `${groups
    .slice(0, 4)
    .map((g) => (g || '0').replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/**
 * KEYS: pairCount, pairBlock, ipCount, ipBlock. ARGV: windowMs, pairFree, ipFree, baseMs, maxMs.
 * Returns { pairFailures, pairBlockMs, ipFailures, ipBlockMs } (block 0 = none started).
 */
const RECORD_FAILURE = `
local function bump(countKey, blockKey, free)
  local n = redis.call('INCR', countKey)
  redis.call('PEXPIRE', countKey, ARGV[1])
  local block = 0
  if n >= free then
    local exp = n - free
    if exp > 30 then exp = 30 end
    block = math.floor(tonumber(ARGV[4]) * (2 ^ exp))
    if block > tonumber(ARGV[5]) then block = tonumber(ARGV[5]) end
    if redis.call('PTTL', blockKey) < block then
      redis.call('SET', blockKey, '1', 'PX', block)
    end
  end
  return { n, block }
end
local a = bump(KEYS[1], KEYS[2], tonumber(ARGV[2]))
local b = bump(KEYS[3], KEYS[4], tonumber(ARGV[3]))
return { a[1], a[2], b[1], b[2] }
`;

/**
 * Login brute-force protection without a global account lock (business rules §2): failures are
 * counted in Redis per (HMAC(email), IP) and per IP, with exponential backoff. A third party
 * can therefore only slow down its own IP, never lock the owner out. Unknown emails use exactly the
 * same counters (the key is the HMAC of whatever was typed), so responses don't reveal existence.
 *
 *   const emailKey = throttle.emailKey(dto.email);
 *   throttle.assertAllowed(await throttle.check(emailKey, ip));  // 429 RATE_LIMITED + Retry-After
 *   if (!ok) { await throttle.recordFailure(emailKey, ip); throw invalidCredentials; }
 *   await throttle.reset(emailKey, ip);                           // on success (pair counter only)
 *
 * Redis outages fail OPEN (logged): the per-IP Nest throttler on auth routes still applies.
 */
@Injectable()
export class LoginThrottleService {
  private readonly logger = new Logger(LoginThrottleService.name);
  private readonly prefix = 'login-throttle:v1:';
  readonly policy: LoginThrottlePolicy;

  constructor(
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
    config: AppConfig,
  ) {
    this.policy = { ...config.loginThrottle };
  }

  /** HMAC(OTP_PEPPER, email) — the email part of the keys. Never store or log the raw address. */
  emailKey(email: string): string {
    return this.crypto.emailHmac(email, 'login-throttle');
  }

  private keys(emailHmac: string, ip: string | null | undefined) {
    const nip = normalizeThrottleIp(ip);
    return {
      pairCount: `${this.prefix}pair:${emailHmac}:${nip}:n`,
      pairBlock: `${this.prefix}pair:${emailHmac}:${nip}:block`,
      ipCount: `${this.prefix}ip:${nip}:n`,
      ipBlock: `${this.prefix}ip:${nip}:block`,
    };
  }

  async check(emailHmac: string, ip: string | null | undefined): Promise<LoginThrottleDecision> {
    const k = this.keys(emailHmac, ip);
    try {
      const [pair, ipBlock] = await Promise.all([this.redis.redis.pttl(k.pairBlock), this.redis.redis.pttl(k.ipBlock)]);
      const worst = Math.max(pair, ipBlock);
      if (worst <= 0) return { allowed: true };
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(worst / 1000)), scope: pair >= ipBlock ? 'account' : 'ip' };
    } catch (err) {
      this.logger.warn({ err }, 'Login throttle check failed (Redis); allowing');
      return { allowed: true };
    }
  }

  /** Throws 429 RATE_LIMITED (`details.retryAfterSeconds`, sent as Retry-After) when blocked. */
  assertAllowed(decision: LoginThrottleDecision): void {
    if (!decision.allowed) {
      throw rateLimited('Too many sign-in attempts. Please wait and try again', { retryAfterSeconds: decision.retryAfterSeconds });
    }
  }

  async recordFailure(emailHmac: string, ip: string | null | undefined): Promise<LoginFailureResult> {
    const k = this.keys(emailHmac, ip);
    const p = this.policy;
    try {
      const [failures, pairBlock, ipFailures, ipBlock] = (await this.redis.redis.eval(
        RECORD_FAILURE,
        4,
        k.pairCount,
        k.pairBlock,
        k.ipCount,
        k.ipBlock,
        String(p.windowMs),
        String(p.freeAttempts),
        String(p.ipFreeAttempts),
        String(p.baseMs),
        String(p.maxMs),
      )) as [number, number, number, number];
      const block = Math.max(pairBlock, ipBlock);
      return { failures, ipFailures, retryAfterSeconds: block > 0 ? Math.ceil(block / 1000) : null };
    } catch (err) {
      this.logger.warn({ err }, 'Login throttle recordFailure failed (Redis)');
      return { failures: 0, ipFailures: 0, retryAfterSeconds: null };
    }
  }

  /** After a successful login: clears the (email, IP) counter and block. The per-IP counter stays. */
  async reset(emailHmac: string, ip: string | null | undefined): Promise<void> {
    const k = this.keys(emailHmac, ip);
    try {
      await this.redis.redis.del(k.pairCount, k.pairBlock);
    } catch (err) {
      this.logger.warn({ err }, 'Login throttle reset failed (Redis)');
    }
  }
}
