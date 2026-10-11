import { describe, expect, it, vi } from 'vitest';
import type { FieldValues, UseFormSetError } from 'react-hook-form';

import { ApiError } from '@/lib/api-client';

import { applyApiFieldErrors } from './apply-api-errors';

interface Values extends FieldValues {
  name: string;
  code: string;
  roles: string[];
}

/** The parts of `useForm()` the helper reads: `setError` and the registered field names. */
function fakeForm(registered: string[]) {
  const setError = vi.fn() as unknown as UseFormSetError<Values> & ReturnType<typeof vi.fn>;
  return { setError, control: { _names: { mount: new Set(registered) } } };
}

const validation = (issues: Array<{ path: string; message: string }>, status = 400, code = 'VALIDATION_FAILED') =>
  new ApiError({ code, message: 'Some fields need attention', status, details: { issues } });

describe('applyApiFieldErrors', () => {
  it('applies issues on registered fields and focuses the first one', () => {
    const form = fakeForm(['name', 'code']);
    const applied = applyApiFieldErrors(
      validation([
        { path: 'code', message: 'Already used' },
        { path: 'name', message: 'Too short' },
      ]),
      form,
    );
    expect(applied).toBe(true);
    expect(form.setError).toHaveBeenCalledTimes(2);
    expect(form.setError).toHaveBeenNthCalledWith(1, 'code', { type: 'server', message: 'Already used' }, { shouldFocus: true });
    expect(form.setError).toHaveBeenNthCalledWith(2, 'name', { type: 'server', message: 'Too short' }, { shouldFocus: false });
  });

  it('returns false (caller shows a toast) when no issue matches a field of the form', () => {
    const form = fakeForm(['name']);
    expect(applyApiFieldErrors(validation([{ path: 'currencyCode', message: 'Must be INR' }]), form)).toBe(false);
    expect(form.setError).not.toHaveBeenCalled();
  });

  it('returns false for 409s whose details are not field issues (invariant, terms changed)', () => {
    const form = fakeForm(['name', 'reason', 'termsVersion']);
    const invariant = new ApiError({
      code: 'INVARIANT_VIOLATION',
      message: 'The change violates a data integrity rule',
      status: 409,
      details: { sqlState: '23001', reason: 'trigger' },
    });
    const terms = new ApiError({ code: 'CONFLICT', message: 'Terms changed', status: 409, details: { termsVersion: '2.0' } });
    expect(applyApiFieldErrors(invariant, form)).toBe(false);
    expect(applyApiFieldErrors(terms, form)).toBe(false);
    expect(form.setError).not.toHaveBeenCalled();
  });

  it('applies a 409 that carries issues for a registered field (duplicate code)', () => {
    const form = fakeForm(['code']);
    expect(applyApiFieldErrors(validation([{ path: 'code', message: 'Taken' }], 409, 'CONFLICT'), form)).toBe(true);
    expect(form.setError).toHaveBeenCalledWith('code', { type: 'server', message: 'Taken' }, { shouldFocus: true });
  });

  it('accepts knownFields for custom controls that are not registered inputs', () => {
    const form = fakeForm([]);
    expect(applyApiFieldErrors(validation([{ path: 'roles', message: 'Pick one' }]), form, { knownFields: ['roles'] })).toBe(true);
    expect(form.setError).toHaveBeenCalledOnce();
  });

  it('with a bare setError only knownFields can be applied', () => {
    const { setError } = fakeForm([]);
    const error = validation([
      { path: 'name', message: 'Too short' },
      { path: 'other', message: 'Nope' },
    ]);
    expect(applyApiFieldErrors(error, setError)).toBe(false);
    expect(applyApiFieldErrors(error, setError, { knownFields: ['name'] })).toBe(true);
    expect(setError).toHaveBeenCalledTimes(1);
    expect(setError).toHaveBeenCalledWith('name', { type: 'server', message: 'Too short' }, { shouldFocus: true });
  });

  it('ignores non-API errors', () => {
    const form = fakeForm(['name']);
    expect(applyApiFieldErrors(new Error('boom'), form)).toBe(false);
    expect(applyApiFieldErrors(undefined, form)).toBe(false);
  });
});
