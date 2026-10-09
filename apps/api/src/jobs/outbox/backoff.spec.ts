import { describe, expect, it } from 'vitest';
import { computeBackoffMs } from './backoff';

describe('computeBackoffMs', () => {
  const mid = () => 0.5; // no jitter

  it('doubles per attempt from the base', () => {
    expect([1, 2, 3, 4].map((a) => computeBackoffMs(a, { random: mid }))).toEqual([5_000, 10_000, 20_000, 40_000]);
  });

  it('is capped at maxMs', () => {
    expect(computeBackoffMs(30, { random: mid })).toBe(3_600_000);
    expect(computeBackoffMs(30, { random: () => 1 })).toBe(3_600_000);
  });

  it('applies ± jitter', () => {
    expect(computeBackoffMs(1, { random: () => 0 })).toBe(4_000);
    expect(computeBackoffMs(1, { random: () => 1 })).toBe(6_000);
  });
});
