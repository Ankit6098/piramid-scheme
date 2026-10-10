import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Permission, type RecordSaleResultDto } from '@app/shared';
import type { AuthContext } from '../../common/auth/auth-context';
import { CurrentUser, RequirePermissions } from '../../common/auth/decorators';
import { ok } from '../../common/http/envelope';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor';
import { IdParamDto } from '../../common/validation/zod';
import { ListSaleEventsQueryDto, RecordSaleDto } from './dto';
import { EventIntakeService } from './event-intake.service';
import { EventsQueryService } from './events-query.service';

/**
 * Admin sales intake and event views (business rules §8). Recording is program-scoped
 * (`events:write` + write access); views need `rewards:read` + read access to the program.
 * Event reversal (`POST /admin/events/:id/reverse`) belongs to the rewards slice.
 */
@ApiTags('admin: events')
@Controller('admin/events')
export class AdminEventsController {
  constructor(
    private readonly intake: EventIntakeService,
    private readonly query: EventsQueryService,
  ) {}

  @Get('programs')
  @RequirePermissions(Permission.ProgramsRead)
  async programs(@CurrentUser() auth: AuthContext) {
    return ok(await this.query.programOptions(auth));
  }

  @Get()
  @RequirePermissions(Permission.RewardsRead)
  list(@Query() q: ListSaleEventsQueryDto, @CurrentUser() auth: AuthContext) {
    return this.query.list(auth, q);
  }

  @Get(':id')
  @RequirePermissions(Permission.RewardsRead)
  async get(@Param() p: IdParamDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.query.getDetail(auth, p.id));
  }

  /** 201 for a new record, 200 when an identical request replays the existing event. */
  @Post()
  @Idempotent({ required: false })
  @RequirePermissions(Permission.EventsWrite)
  async record(@Body() body: RecordSaleDto, @CurrentUser() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    const result = await this.intake.record({ kind: 'ADMIN', auth }, body);
    const event = await this.query.getDetail(null, result.eventId);
    res.status(result.replayed ? 200 : 201);
    const dto: RecordSaleResultDto = { event, outcome: event.outcome, replayed: result.replayed };
    return ok(dto);
  }
}
