/**
 * Per-account cap on authenticator (TOTP) guesses (business rules §2 "Admin MFA"). The login backoff
 * counts failures per (user, IP) and per IP, which an attacker who already knows an admin's password
 * can spread over many addresses. This counter is keyed by the account only: after `threshold`
 * consecutive wrong codes (any endpoint, any IP) TOTP verification for that account is paused for
 * `baseMs`, doubling with every further failure up to `maxMs`. A correct code resets it; failures
 * expire after `windowMs` without a new one.
 */
export interface TotpLockoutPolicy {
  threshold: number;
  baseMs: number;
  maxMs: number;
  windowMs: number;
}

export const TOTP_LOCKOUT_POLICY: TotpLockoutPolicy = {
  threshold: 10,
  baseMs: 15 * 60_000,
  maxMs: 24 * 3_600_000,
  windowMs: 24 * 3_600_000,
};

/** Lock duration after `failures` consecutive failures: 0 below the threshold, then base·2^(n − threshold) ≤ max. */
export function totpLockoutMs(failures: number, policy: TotpLockoutPolicy = TOTP_LOCKOUT_POLICY): number {
  if (failures < policy.threshold) return 0;
  const exp = Math.min(30, failures - policy.threshold);
  return Math.min(policy.maxMs, policy.baseMs * 2 ** exp);
}
