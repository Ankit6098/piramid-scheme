import { describe, expect, it } from 'vitest';
import { allLimited } from './concurrency';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('allLimited', () => {
  it('keeps result positions and never runs more than `limit` tasks at once', async () => {
    let running = 0;
    let peak = 0;
    const task = (v: number, ms: number) => async () => {
      running += 1;
      peak = Math.max(peak, running);
      await tick(ms);
      running -= 1;
      return v;
    };
    const results = await allLimited(2, [task(1, 20), task(2, 5), task(3, 10), task(4, 1), task(5, 5)]);
    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it('preserves heterogeneous tuple results', async () => {
    const [a, b] = await allLimited(1, [async () => 'x', async () => 42] as const);
    expect(a.toUpperCase()).toBe('X');
    expect(b + 1).toBe(43);
  });

  it('rejects with the first failure and starts no further tasks', async () => {
    const started: number[] = [];
    const tasks = [0, 1, 2, 3].map((i) => async () => {
      started.push(i);
      if (i === 0) throw new Error('boom');
      await tick(5);
      return i;
    });
    await expect(allLimited(1, tasks)).rejects.toThrow('boom');
    expect(started).toEqual([0]);
  });
});
