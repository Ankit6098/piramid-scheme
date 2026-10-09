import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
import { serviceUnavailable } from '../errors/app-error';
import { ok } from '../http/envelope';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { SkipDefaultThrottle } from '../throttle/throttle';

type CheckStatus = 'up' | 'down';

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

@ApiTags('health')
@Public()
@SkipDefaultThrottle()
@Controller('health')
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Liveness: the process is up and serving HTTP. No dependencies are touched. */
  @Get()
  live() {
    return ok({ status: 'ok' as const, uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000) });
  }

  /** Readiness: database (SELECT 1) and Redis (PING). 503 SERVICE_UNAVAILABLE when any is down. */
  @Get('ready')
  async ready() {
    const [database, redis] = await Promise.all([
      withTimeout(this.prisma.$queryRaw`SELECT 1`, 2_000)
        .then((): CheckStatus => 'up')
        .catch((): CheckStatus => 'down'),
      this.redis.ping(1_500).then((up): CheckStatus => (up ? 'up' : 'down')),
    ]);
    const checks = { database, redis };
    if (database !== 'up' || redis !== 'up') throw serviceUnavailable('Service not ready', { checks });
    return ok({ status: 'ok' as const, checks });
  }
}
