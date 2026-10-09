import { Body, Controller, Get, HttpCode, Module, Post } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { AuthContext } from '../../src/common/auth/auth-context';
import { CurrentUser, OptionalAuth, Public, RequirePermissions } from '../../src/common/auth/decorators';
import { SkipCsrf } from '../../src/common/csrf/csrf.guard';
import { ok } from '../../src/common/http/envelope';
import { IdempotencyKey } from '../../src/common/idempotency/idempotency-key.decorator';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { RateLimit } from '../../src/common/throttle/throttle';

class EchoDto extends createZodDto(z.object({ name: z.string().min(2), amountMinor: z.string().regex(/^\d+$/) })) {}

function authView(auth: AuthContext) {
  return { ...auth, permissions: [...auth.permissions].sort() };
}

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

  /** Writes an unbalanced ledger transaction → deferred trigger fails at COMMIT → 409. */
  @Public()
  @Post('unbalanced-ledger')
  async unbalancedLedger() {
    await this.prisma.$transaction(async (tx) => {
      const [expense, payable] = await Promise.all([
        tx.ledgerAccount.findFirstOrThrow({ where: { type: 'PLATFORM_REWARD_EXPENSE' } }),
        tx.ledgerAccount.findFirstOrThrow({ where: { type: 'MEMBER_REWARDS_PAYABLE' } }),
      ]);
      const txn = await tx.ledgerTransaction.create({
        data: { type: 'REWARD_POSTING', idempotencyKey: `probe:${Date.now()}:${Math.random()}` },
      });
      await tx.ledgerEntry.createMany({
        data: [
          { transactionId: txn.id, accountId: expense.id, direction: 'DEBIT', amountMinor: 100n, rewardUnit: 'MONEY', currencyCode: 'INR' },
          { transactionId: txn.id, accountId: payable.id, direction: 'CREDIT', amountMinor: 60n, rewardUnit: 'MONEY', currencyCode: 'INR' },
        ],
      });
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
