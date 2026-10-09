export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** ± fraction of the delay (0.2 = ±20 %). */
  jitter?: number;
  random?: () => number;
}

/** Exponential backoff with jitter: base·2^(attempt−1), capped, ±jitter. `attempt` starts at 1. */
export function computeBackoffMs(attempt: number, options: BackoffOptions = {}): number {
  const { baseMs = 5_000, maxMs = 60 * 60_000, jitter = 0.2, random = Math.random } = options;
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const factor = 1 + jitter * (2 * random() - 1);
  return Math.max(0, Math.round(Math.min(maxMs, exp * factor)));
}
