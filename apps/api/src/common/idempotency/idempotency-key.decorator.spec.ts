import { describe, expect, it } from 'vitest';
import { AppError } from '../errors/app-error';
import { parseIdempotencyKey } from './idempotency-key.decorator';

describe('parseIdempotencyKey', () => {
  it('returns undefined when absent and optional', () => {
    expect(parseIdempotencyKey(undefined)).toBeUndefined();
    expect(parseIdempotencyKey('')).toBeUndefined();
  });

  it('accepts 8..128 safe characters', () => {
    expect(parseIdempotencyKey('a1b2c3d4')).toBe('a1b2c3d4');
    expect(parseIdempotencyKey(['0b7f6f0e-1a2b-4c3d-9e8f-001122334455'])).toBe('0b7f6f0e-1a2b-4c3d-9e8f-001122334455');
    expect(parseIdempotencyKey('x'.repeat(128))).toHaveLength(128);
  });

  it.each([['short'], ['x'.repeat(129)], ['has space here'], ['semi;colon!']])('rejects %s', (value) => {
    expect(() => parseIdempotencyKey(value)).toThrow(AppError);
  });

  it('requires the header when asked', () => {
    let caught: unknown;
    try {
      parseIdempotencyKey(undefined, true);
    } catch (e) {
      caught = e;
    }
    expect((caught as AppError).code).toBe('VALIDATION_FAILED');
  });
});
