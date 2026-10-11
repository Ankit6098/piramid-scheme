import { describe, expect, it } from 'vitest';

import { ApiError, extractFieldErrors, parseRetryAfter } from './api-client';

describe('extractFieldErrors', () => {
  it('reads the API issue shapes (details.issues / errors / fieldErrors / bare array)', () => {
    expect(
      extractFieldErrors({
        issues: [
          { path: 'paymentReference', message: 'Already used', code: 'custom' },
          { path: ['rules', 0, 'percentageBps'], message: 'Too high' },
        ],
      }),
    ).toEqual({ paymentReference: 'Already used', 'rules.0.percentageBps': 'Too high' });
    expect(extractFieldErrors({ errors: [{ field: 'sku', message: 'Taken' }] })).toEqual({ sku: 'Taken' });
    expect(extractFieldErrors({ fieldErrors: { name: ['Required', 'Too short'] } })).toEqual({ name: 'Required' });
    expect(extractFieldErrors([{ path: 'code', message: 'Bad' }])).toEqual({ code: 'Bad' });
  });

  it('keeps the first message per path and skips empty or malformed issues', () => {
    expect(
      extractFieldErrors({
        issues: [
          { path: 'name', message: 'First' },
          { path: 'name', message: 'Second' },
          { path: '', message: 'No path' },
          { path: 'x', message: '' },
          null,
          'oops',
        ],
      }),
    ).toEqual({ name: 'First' });
  });

  it('never treats other details objects as a field map (409 context, invariant violations)', () => {
    // Terms changed (enrollment), invariant violation, invalid state, retryable conflict, SoD.
    expect(extractFieldErrors({ termsVersion: '2.0' })).toEqual({});
    expect(extractFieldErrors({ sqlState: '23001', reason: 'Reward total exceeds 50% of the sale' })).toEqual({});
    expect(extractFieldErrors({ status: 'RESOLVED' })).toEqual({});
    expect(extractFieldErrors({ retryable: true })).toEqual({});
    expect(extractFieldErrors({ reason: 'RECORDER_SOD', rule: 'OWN_SALE' })).toEqual({});
    expect(extractFieldErrors(undefined)).toEqual({});
    expect(extractFieldErrors('text')).toEqual({});
  });

  it('skips policy warnings (they never block a request)', () => {
    expect(
      extractFieldErrors({
        issues: [
          { severity: 'warning', path: 'budgetBps', message: 'Unusually high' },
          { severity: 'error', path: 'maxDepth', message: 'Above the program limit' },
        ],
      }),
    ).toEqual({ maxDepth: 'Above the program limit' });
  });
});

describe('ApiError', () => {
  it('exposes field errors only for issue-shaped details', () => {
    const validation = new ApiError({
      code: 'VALIDATION_FAILED',
      message: 'Invalid',
      status: 400,
      details: { issues: [{ path: 'email', message: 'Invalid email' }] },
    });
    expect(validation.hasFieldErrors).toBe(true);
    expect(validation.fieldErrors).toEqual({ email: 'Invalid email' });

    const conflictWithIssues = new ApiError({
      code: 'CONFLICT',
      message: 'Another program already uses this code',
      status: 409,
      details: { issues: [{ path: 'code', message: 'This code is already used by another program' }] },
    });
    expect(conflictWithIssues.fieldErrors).toEqual({ code: 'This code is already used by another program' });

    const invariant = new ApiError({
      code: 'INVARIANT_VIOLATION',
      message: 'The change violates a data integrity rule',
      status: 409,
      details: { sqlState: '23001', reason: 'trigger message' },
    });
    expect(invariant.hasFieldErrors).toBe(false);
    expect(invariant.isConflict).toBe(true);
  });

  it('takes the wait from details.retryAfterSeconds, else from the Retry-After header', () => {
    expect(
      new ApiError({ code: 'RATE_LIMITED', message: 'x', status: 429, details: { retryAfterSeconds: 12.2 }, retryAfterSeconds: 60 })
        .retryAfterSeconds,
    ).toBe(13);
    expect(new ApiError({ code: 'RATE_LIMITED', message: 'x', status: 429, retryAfterSeconds: 30 }).retryAfterSeconds).toBe(30);
    expect(new ApiError({ code: 'RATE_LIMITED', message: 'x', status: 429 }).retryAfterSeconds).toBeUndefined();
    expect(
      new ApiError({ code: 'RATE_LIMITED', message: 'x', status: 429, details: { retryAfterSeconds: 0 } }).retryAfterSeconds,
    ).toBeUndefined();
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-10-11T10:00:00.000Z');

  it('parses delta-seconds and HTTP dates', () => {
    expect(parseRetryAfter('42', now)).toBe(42);
    expect(parseRetryAfter(' 7 ', now)).toBe(7);
    expect(parseRetryAfter('Sun, 11 Oct 2026 10:01:30 GMT', now)).toBe(90);
  });

  it('ignores missing, malformed, zero and past values', () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter('', now)).toBeUndefined();
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter('0', now)).toBeUndefined();
    expect(parseRetryAfter('Sun, 11 Oct 2026 09:59:00 GMT', now)).toBeUndefined();
  });
});
