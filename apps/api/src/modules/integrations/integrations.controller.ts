import { Body, Controller, Get, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Permission } from '@app/shared';
import type { AuthContext } from '../../common/auth/auth-context';
import { CurrentUser, Public, RequirePermissions } from '../../common/auth/decorators';
import { SkipCsrf } from '../../common/csrf/csrf.guard';
import { ok } from '../../common/http/envelope';
import { IdParamDto } from '../../common/validation/zod';
import { IngestSaleDto } from '../events/dto';
import { EventIntakeService } from '../events/event-intake.service';
import { EventsQueryService } from '../events/events-query.service';
import { ApiKeyGuard, CurrentApiClient } from './api-key.guard';
import { CreateApiClientDto, ListApiClientsQueryDto, RevokeApiClientDto } from './dto';
import { IntegrationsService, type ApiClientPrincipal } from './integrations.service';

/** API client management (SUPER_ADMIN: `integrations:manage`). */
@ApiTags('admin: integrations')
@Controller('admin/integrations')
export class AdminIntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get('clients')
  @RequirePermissions(Permission.IntegrationsManage)
  list(@Query() q: ListApiClientsQueryDto, @CurrentUser() auth: AuthContext) {
    return this.integrations.list(auth, q);
  }

  /** The full key is returned once, here. */
  @Post('clients')
  @RequirePermissions(Permission.IntegrationsManage)
  async create(@Body() body: CreateApiClientDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.integrations.create(auth, body));
  }

  @Post('clients/:id/revoke')
  @HttpCode(200)
  @RequirePermissions(Permission.IntegrationsManage)
  async revoke(@Param() p: IdParamDto, @Body() body: RevokeApiClientDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.integrations.revoke(auth, p.id, body));
  }
}

/**
 * Machine sales ingestion: `POST /api/v1/integrations/events` with `Authorization: Bearer <key>`.
 * No cookie session, no CSRF; rate-limited per client IP. Same intake rules as the admin form
 * (source = API); 201 for a new record, 200 for an identical replay.
 */
@ApiTags('integrations')
@Controller('integrations')
export class IntegrationsIngestController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly intake: EventIntakeService,
    private readonly query: EventsQueryService,
  ) {}

  @Post('events')
  @Public()
  @SkipCsrf()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @UseGuards(ApiKeyGuard)
  async ingest(@CurrentApiClient() client: ApiClientPrincipal, @Body() body: IngestSaleDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.intake.record(
      { kind: 'API_CLIENT', clientId: client.id, programId: client.programId },
      { ...body, programId: body.programId ?? client.programId },
    );
    await this.integrations.touch(client.id);
    res.status(result.replayed ? 200 : 201);
    return ok(await this.query.getIntegrationResult(result.eventId, result.replayed));
  }
}
