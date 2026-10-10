import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../../common/auth/auth-context';
import { CurrentUser, RequirePermissions } from '../../common/auth/decorators';
import { ok } from '../../common/http/envelope';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor';
import { IdParamDto } from '../../common/validation/zod';
import { EventReversalDto } from './dto';
import { EventReversalService } from './event-reversal.service';

/**
 * POST /api/v1/admin/events/:id/reverse — refund / chargeback of a processed sale. Lives in the
 * rewards module because it rejects / reverses the sale's rewards in the same transaction; the rest
 * of /admin/events belongs to the events module.
 */
@ApiTags('events')
@Controller('admin/events')
export class AdminEventReversalController {
  constructor(private readonly reversals: EventReversalService) {}

  @Post(':id/reverse')
  @HttpCode(200)
  @Idempotent()
  @RequirePermissions('events:reverse')
  async reverse(@CurrentUser() auth: AuthContext, @Param() p: IdParamDto, @Body() body: EventReversalDto) {
    return ok(await this.reversals.reverse(auth, p.id, body.reason));
  }
}
