/**
 * Pure rules for email one-time codes (business rules §2 "OTP codes"). The DB keeps one row per issued
 * code in `email_challenges`; these functions derive the send/verify limits from that history so the
 * counters survive restarts and are shared by every API replica.
 */

export interface OtpPolicy {
  /** Code lifetime. */
  ttlMs: number;
  /** Verification attempts per code. */
  maxAttempts: number;
  /** Minimum gap between two codes for the same (address, purpose). */
  cooldownMs: number;
  /** Codes per (address, purpose) per rolling hour. */
  hourlySendCap: number;
  /** Failed attempts per (address, purpose) in `failedWindowMs` that block sends and verifications. */
  failedCap: number;
  failedWindowMs: number;
}

export const OTP_POLICY: OtpPolicy = {
  ttlMs: 10 * 60_000,
  maxAttempts: 5,
  cooldownMs: 60_000,
  hourlySendCap: 5,
  failedCap: 10,
  failedWindowMs: 24 * 3_600_000,
};

const HOUR_MS = 3_600_000;

/** One issued code (an `email_challenges` row) as far as the limits are concerned. */
export interface ChallengeHistoryRow {
  createdAt: Date;
  attempts: number;
  consumedAt: Date | null;
}

export interface ChallengeHistorySummary {
  /** Codes issued in the last hour. */
  sendsLastHour: number;
  /** Failed verification attempts in the failure window (a consumed code's last attempt succeeded). */
  failedInWindow: number;
  /** When the most recent code was issued (null = never in the window). */
  lastSentAt: Date | null;
  /** Oldest row in the failure window that still has failed attempts (for Retry-After). */
  oldestFailureAt: Date | null;
  /** Oldest code inside the last hour (for Retry-After of the hourly cap). */
  oldestSendInHourAt: Date | null;
}

export function failedAttemptsOf(row: ChallengeHistoryRow): number {
  return Math.max(0, row.attempts - (row.consumedAt ? 1 : 0));
}

/** Summarizes the challenge history of one (address, purpose) — rows of any age may be passed. */
export function summarizeHistory(
  rows: readonly ChallengeHistoryRow[],
  now: Date,
  policy: OtpPolicy = OTP_POLICY,
): ChallengeHistorySummary {
  const t = now.getTime();
  let sendsLastHour = 0;
  let failedInWindow = 0;
  let lastSentAt: Date | null = null;
  let oldestFailureAt: Date | null = null;
  let oldestSendInHourAt: Date | null = null;
  for (const row of rows) {
    const age = t - row.createdAt.getTime();
    if (age < HOUR_MS) {
      sendsLastHour += 1;
      if (!oldestSendInHourAt || row.createdAt < oldestSendInHourAt) oldestSendInHourAt = row.createdAt;
    }
    if (age < policy.failedWindowMs) {
      const failed = failedAttemptsOf(row);
      failedInWindow += failed;
      if (failed > 0 && (!oldestFailureAt || row.createdAt < oldestFailureAt)) oldestFailureAt = row.createdAt;
    }
    if (!lastSentAt || row.createdAt > lastSentAt) lastSentAt = row.createdAt;
  }
  return { sendsLastHour, failedInWindow, lastSentAt, oldestFailureAt, oldestSendInHourAt };
}

/** ≥ `failedCap` failed attempts in the window block further sends AND verifications. */
export function isBlocked(summary: ChallengeHistorySummary, policy: OtpPolicy = OTP_POLICY): boolean {
  return summary.failedInWindow >= policy.failedCap;
}

export type OtpSendRefusal = 'BLOCKED' | 'HOURLY_CAP' | 'COOLDOWN';

export type OtpSendDecision =
  | { allowed: true }
  | { allowed: false; reason: OtpSendRefusal; retryAfterSeconds: number };

function secondsUntil(at: number, now: number): number {
  return Math.max(1, Math.ceil((at - now) / 1000));
}

/**
 * May a new code be issued now? Order: cumulative failure block, hourly cap, cooldown.
 * `enforceCooldown: false` is used when a request must replace the pending one regardless of the
 * cooldown (a newer registration always supersedes the older pending payload — see AuthService).
 */
export function decideSend(
  summary: ChallengeHistorySummary,
  now: Date,
  options: { enforceCooldown?: boolean } = {},
  policy: OtpPolicy = OTP_POLICY,
): OtpSendDecision {
  const t = now.getTime();
  if (isBlocked(summary, policy)) {
    const from = summary.oldestFailureAt?.getTime() ?? t;
    return { allowed: false, reason: 'BLOCKED', retryAfterSeconds: secondsUntil(from + policy.failedWindowMs, t) };
  }
  if (summary.sendsLastHour >= policy.hourlySendCap) {
    const from = summary.oldestSendInHourAt?.getTime() ?? t;
    return { allowed: false, reason: 'HOURLY_CAP', retryAfterSeconds: secondsUntil(from + HOUR_MS, t) };
  }
  if (options.enforceCooldown !== false && summary.lastSentAt && t - summary.lastSentAt.getTime() < policy.cooldownMs) {
    return {
      allowed: false,
      reason: 'COOLDOWN',
      retryAfterSeconds: secondsUntil(summary.lastSentAt.getTime() + policy.cooldownMs, t),
    };
  }
  return { allowed: true };
}

/** Day bucket used to de-duplicate "too many failed attempts" notices (one per address per day). */
export function dayBucket(now: Date): number {
  return Math.floor(now.getTime() / 86_400_000);
}

/** Hour bucket used to de-duplicate courtesy notices (registration attempts, address-taken notices). */
export function hourBucket(now: Date): number {
  return Math.floor(now.getTime() / HOUR_MS);
}
