import { BadRequestException, ForbiddenException, NotFoundException, NotImplementedException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { ZodValidationException } from 'nestjs-zod';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client';
import { RequestContext } from '../context/request-context';
import { AllExceptionsFilter, normalizeError } from './all-exceptions.filter';
import { AppError, conflict, notFound } from './app-error';

function prismaError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError(`prisma ${code}`, { code, clientVersion: '7.10.0', meta });
}

/** Shape produced by @prisma/adapter-pg for a pg error (meta.driverAdapterError.cause). */
function adapterError(code: string, cause: Record<string, unknown>) {
  const driverAdapterError = Object.assign(new Error('driver'), { name: 'DriverAdapterError', cause });
  return prismaError(code, { driverAdapterError, modelName: 'X' });
}

describe('normalizeError (exception → public error mapping)', () => {
  it('passes AppError through', () => {
    expect(normalizeError(notFound('Program'))).toMatchObject({ status: 404, code: 'NOT_FOUND', message: 'Program not found', unexpected: false });
    expect(normalizeError(conflict('Taken', { field: 'code' }))).toMatchObject({ status: 409, code: 'CONFLICT', details: { field: 'code' } });
    expect(normalizeError(new AppError('OTP_COOLDOWN', 'Wait'))).toMatchObject({ status: 429, code: 'OTP_COOLDOWN' });
  });

  it('maps ZodValidationException → 400 VALIDATION_FAILED with field issues', () => {
    const parsed = z.object({ email: z.email(), age: z.number().int() }).safeParse({ email: 'nope', age: 1.5 });
    const n = normalizeError(new ZodValidationException(parsed.error));
    expect(n.status).toBe(400);
    expect(n.code).toBe('VALIDATION_FAILED');
    const issues = (n.details as { issues: Array<{ path: string; code: string }> }).issues;
    expect(issues.map((i) => i.path).sort()).toEqual(['age', 'email']);
  });

  it('maps a raw ZodError → 400 too', () => {
    const parsed = z.object({ a: z.string() }).safeParse({});
    expect(normalizeError(parsed.error)).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });

  it('maps ThrottlerException → 429 RATE_LIMITED', () => {
    expect(normalizeError(new ThrottlerException())).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
  });

  it('maps Nest HttpExceptions by status', () => {
    expect(normalizeError(new NotFoundException('Cannot GET /x'))).toMatchObject({ status: 404, code: 'NOT_FOUND', message: 'Not found' });
    expect(normalizeError(new ForbiddenException())).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(normalizeError(new BadRequestException('Unexpected token } in JSON'))).toMatchObject({ status: 400, message: 'Malformed JSON body' });
    expect(normalizeError(new NotImplementedException('rewards slice'))).toMatchObject({ status: 501, code: 'NOT_IMPLEMENTED', unexpected: false });
  });

  it('maps Prisma P2002 → 409 CONFLICT and P2025 → 404 NOT_FOUND', () => {
    expect(normalizeError(prismaError('P2002', { target: ['email'] }))).toMatchObject({ status: 409, code: 'CONFLICT', details: { constraint: 'email' } });
    expect(normalizeError(prismaError('P2025'))).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('maps restrict/check/exclusion SQLSTATEs from the driver adapter → 409 INVARIANT_VIOLATION', () => {
    const restrict = adapterError('P2003', { kind: 'RestrictViolation', originalCode: '23001', originalMessage: 'Rewards cannot be deleted' });
    expect(normalizeError(restrict)).toMatchObject({
      status: 409,
      code: 'INVARIANT_VIOLATION',
      details: { sqlState: '23001', reason: 'Rewards cannot be deleted' },
    });
    const check = adapterError('P2039', {
      kind: 'postgres',
      code: '23514',
      originalCode: '23514',
      originalMessage: 'new row for relation "rewards" violates check constraint "ck_rewards_amount"',
    });
    expect(normalizeError(check)).toMatchObject({ status: 409, code: 'INVARIANT_VIOLATION', details: { sqlState: '23514', constraint: 'ck_rewards_amount' } });
    const exclusion = Object.assign(new Error('x'), {
      name: 'DriverAdapterError',
      cause: { kind: 'postgres', originalCode: '23P01', originalMessage: 'conflicting key value violates exclusion constraint "ex_policy_versions_no_overlap"' },
    });
    expect(normalizeError(exclusion)).toMatchObject({ status: 409, code: 'INVARIANT_VIOLATION', details: { constraint: 'ex_policy_versions_no_overlap' } });
  });

  it('keeps foreign-key violations (P2003 / 23503) as 409 CONFLICT', () => {
    const fk = adapterError('P2003', { kind: 'ForeignKeyConstraintViolation', originalCode: '23503', constraint: { index: 'fk_x' } });
    expect(normalizeError(fk)).toMatchObject({ status: 409, code: 'CONFLICT' });
  });

  it('maps raw pg errors by SQLSTATE without echoing `detail`', () => {
    const pg = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), {
      code: '23505',
      severity: 'ERROR',
      detail: 'Key (email)=(secret@example.com) already exists.',
    });
    const n = normalizeError(pg);
    expect(n).toMatchObject({ status: 409, code: 'CONFLICT', details: { constraint: 'users_email_key' } });
    expect(JSON.stringify(n.details)).not.toContain('secret@example.com');
  });

  it('maps body-parser errors (413 / malformed JSON)', () => {
    expect(normalizeError(Object.assign(new Error('too large'), { status: 413, type: 'entity.too.large' }))).toMatchObject({
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
    });
    expect(normalizeError(Object.assign(new Error('bad'), { status: 400, type: 'entity.parse.failed' }))).toMatchObject({
      status: 400,
      message: 'Malformed JSON body',
    });
  });

  it('maps unknown errors → 500 INTERNAL_ERROR without leaking the message', () => {
    const n = normalizeError(new Error('connection string postgres://user:pw@host'));
    expect(n).toMatchObject({ status: 500, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', unexpected: true });
    expect(normalizeError('a string')).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
  });
});

describe('AllExceptionsFilter', () => {
  function host() {
    const res = {
      headersSent: false,
      statusCode: 0,
      body: undefined as unknown,
      headers: {} as Record<string, string>,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(b: unknown) {
        this.body = b;
        return this;
      },
      getHeader(name: string) {
        return this.headers[name];
      },
      setHeader(name: string, v: string) {
        this.headers[name] = v;
      },
    };
    const h = {
      getType: () => 'http',
      switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ id: 'req-from-req' }) }),
    };
    return { res, h };
  }

  it('renders the error envelope with the request id and JSON-safe details', () => {
    const { res, h } = host();
    RequestContext.run({ requestId: 'req-ctx-1' }, () =>
      new AllExceptionsFilter().catch(new AppError('CONFLICT', 'Nope', 409, { amountMinor: 10n }), h as never),
    );
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: { code: 'CONFLICT', message: 'Nope', details: { amountMinor: '10' }, requestId: 'req-ctx-1' } });
  });

  it('logs unexpected errors and returns a generic 500', () => {
    const { res, h } = host();
    const filter = new AllExceptionsFilter();
    const logger = (filter as unknown as { logger: { error: (...a: unknown[]) => void } }).logger;
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    filter.catch(new Error('boom'), h as never);
    expect(spy).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId: 'req-from-req' } });
  });

  it('sets Retry-After on 429', () => {
    const { res, h } = host();
    new AllExceptionsFilter().catch(new ThrottlerException(), h as never);
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('60');
  });
});
