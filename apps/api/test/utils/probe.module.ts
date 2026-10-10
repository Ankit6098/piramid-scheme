import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Module, Param, Post } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { AuthContext } from '../../src/common/auth/auth-context';
import { CurrentUser, OptionalAuth, Public, RequirePermissions } from '../../src/common/auth/decorators';
import { SkipCsrf } from '../../src/common/csrf/csrf.guard';
import { ok } from '../../src/common/http/envelope';
import { conflict } from '../../src/common/errors/app-error';
import { IdempotencyKey } from '../../src/common/idempotency/idempotency-key.decorator';
import { Idempotent } from '../../src/common/idempotency/idempotency.interceptor';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { RateLimit } from '../../src/common/throttle/throttle';

class EchoDto extends createZodDto(z.object({ name: z.string().min(2), amountMinor: z.string().regex(/^\d+$/) })) {}
class AmountDto extends createZodDto(z.object({ amountMinor: z.string().regex(/^\d+$/) })) {}

function authView(auth: AuthContext) {
  return { ...auth, permissions: [...auth.permissions].sort() };
}

/** Counts executions of the idempotent probe handlers (replays must not run the handler). */
export const probeCounters = { idempotentRuns: 0 };

/** Test-only routes that exercise the core guards/pipes/filters (mounted by createTestApp({ imports })). */
@Controller('__probe')
export class ProbeController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('me')
  me(@CurrentUser() auth: AuthContext) {
    return ok(authView(auth));
  }

  @Post('echo')
  @HttpCode(200)
  echo(@Body() body: EchoDto, @CurrentUser() auth: AuthContext) {
    return ok({ ...body, amountMinor: BigInt(body.amountMinor) * 2n, userId: auth.userId });
  }

  @Public()
  @Post('public-echo')
  @HttpCode(200)
  publicEcho(@Body() body: Record<string, unknown>) {
    return ok({ received: body ?? null });
  }

  @Public()
  @SkipCsrf()
  @Post('webhook')
  @HttpCode(200)
  webhook() {
    return ok({ accepted: true });
  }

  @OptionalAuth()
  @Get('optional')
  optional(@CurrentUser({ optional: true }) auth: AuthContext | null) {
    return ok({ userId: auth?.userId ?? null });
  }

  @Get('needs-approve')
  @RequirePermissions('rewards:approve', 'rewards:read')
  needsApprove() {
    return ok({ allowed: true });
  }

  @Public()
  @Get('bigint')
  bigint() {
    return ok({ amountMinor: 9_007_199_254_740_993n, nested: [{ v: 1n }], when: new Date('2026-01-01T00:00:00.000Z') });
  }

  @Public()
  @RateLimit('otp', { limit: 2, ttl: 60_000 })
  @Get('otp-limited')
  otpLimited() {
    return ok({ ok: true });
  }

  @Public()
  @RateLimit('auth')
  @Post('auth-limited')
  @HttpCode(200)
  authLimited() {
    return ok({ ok: true });
  }

  @Public()
  @Post('idempotent')
  @HttpCode(200)
  idempotent(@IdempotencyKey({ required: true }) key: string) {
    return ok({ key });
  }

  @Public()
  @Get('boom')
  boom(): never {
    throw new Error('secret internal detail: password=hunter2');
  }

  /** @Idempotent() financial-style mutation: returns a fresh opId on every real execution. */
  @Post('idempotent-op/:ref')
  @HttpCode(201)
  @Idempotent()
  idempotentOp(@Param('ref') ref: string, @Body() body: AmountDto) {
    probeCounters.idempotentRuns += 1;
    return ok({ opId: randomUUID(), ref, amountMinor: BigInt(body.amountMinor) });
  }

  /** @Idempotent() route that fails: the key must be released so a retry runs again. */
  @Post('idempotent-fail')
  @Idempotent()
  idempotentFail() {
    probeCounters.idempotentRuns += 1;
    throw conflict('probe failure');
  }

  /** Trigger raising restrict_violation (23001) immediately: currencies are immutable. */
  @Public()
  @Post('invariant/immediate')
  async invariantImmediate() {
    await this.prisma.$executeRaw`UPDATE "currencies" SET "minor_units" = 3 WHERE "code" = 'INR'`;
    return ok({ committed: true });
  }

  /** CHECK violation (23514): a plaintext OTP in an outbox payload (bypassing OutboxService). */
  @Public()
  @Post('invariant/check')
  async invariantCheck() {
    await this.prisma.outboxMessage.create({ data: { topic: 'email.send', payload: { to: 'a@b.c', data: { otp: '123456' } } } });
    return ok({ committed: true });
  }

  /** Deferred constraint trigger failing at COMMIT: removing every SUPER_ADMIN grant. */
  @Public()
  @Post('invariant/deferred')
  async invariantDeferred() {
    await this.prisma.$transaction(async (tx) => {
      await tx.userRole.deleteMany({ where: { role: { key: 'SUPER_ADMIN' } } });
    });
    return ok({ committed: true });
  }
}

@Controller('admin/__probe')
export class AdminProbeController {
  @Get('ping')
  ping(@CurrentUser() auth: AuthContext) {
    return ok({ pong: true, userId: auth.userId });
  }
}

@Module({ controllers: [ProbeController, AdminProbeController] })
export class ProbeModule {}
