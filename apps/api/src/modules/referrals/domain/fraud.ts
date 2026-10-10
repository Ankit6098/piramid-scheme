/**
 * Advisory fraud heuristics (business rules §12). Flags never change balances.
 */

/** ≥ this many attributions to one sponsor from one registration IP within the window → flag. */
export const SHARED_IP_THRESHOLD = 3;
export const SHARED_IP_WINDOW_HOURS = 24;

/** Dedupe key of the OPEN `SHARED_IP_REGISTRATIONS` flag (unique while OPEN, DB partial index). */
export function sharedIpDedupeKey(sponsorUserId: string, ip: string): string {
  return `SHARED_IP:${sponsorUserId}:${ip}`.slice(0, 160);
}

export function isSharedIpSuspicious(count: number): boolean {
  return count >= SHARED_IP_THRESHOLD;
}

/** Admin-only explanation stored on the flag. */
export function sharedIpFlagDetails(count: number, ip: string, latestAt: Date): string {
  return (
    `${count} registrations were attributed to this member from the IP address ${ip} within ` +
    `${SHARED_IP_WINDOW_HOURS} hours (latest at ${latestAt.toISOString()}). ` +
    'Review the accounts for self-referral or fake sign-ups. Advisory only: no balances were changed.'
  ).slice(0, 2000);
}
