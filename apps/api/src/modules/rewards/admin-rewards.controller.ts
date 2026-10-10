import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthContext } from '../../common/auth/auth-context';
import { CurrentUser, RequirePermissions } from '../../common/auth/decorators';
import { ok } from '../../common/http/envelope';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor';
import { IdParamDto } from '../../common/validation/zod';
import { csvFilename } from '../ledger/domain/csv';
import { streamCsv } from '../ledger/csv-response';
import {
  AdminRewardCountsQueryDto,
  AdminRewardExportQueryDto,
  AdminRewardListQueryDto,
  BulkApproveRewardsDto,
  RejectRewardDto,
  ReverseRewardDto,
} from './dto';
import { RewardDecisionsService } from './reward-decisions.service';
import { RewardsExportService } from './rewards-export.service';
import { RewardsQueryService } from './rewards-query.service';

/**
 * Admin reward routes (/api/v1/admin/rewards): approval queue, detail with calculation trace,
 * decisions (approve = approve + post), exports. Program-scoped for PROGRAM_ADMIN (read only).
 * Decisions require an `Idempotency-Key` header.
 */
@ApiTags('rewards')
@Controller('admin/rewards')
export class AdminRewardsController {
  constructor(
    private readonly query: RewardsQueryService,
    private readonly decisions: RewardDecisionsService,
    private readonly exports: RewardsExportService,
  ) {}

  @Get()
  @RequirePermissions('rewards:read')
  list(@CurrentUser() auth: AuthContext, @Query() q: AdminRewardListQueryDto) {
    return this.query.listAdmin(auth, q);
  }

  @Get('counts')
  @RequirePermissions('rewards:read')
  async counts(@CurrentUser() auth: AuthContext, @Query() q: AdminRewardCountsQueryDto) {
    return ok(await this.query.countsAdmin(auth, q));
  }

  @Get('facets')
  @RequirePermissions('rewards:read')
  async facets(@CurrentUser() auth: AuthContext) {
    return ok(await this.query.facetsAdmin(auth));
  }

  /** Same filters as the list; streamed; CSV-injection safe; audited. */
  @Get('export.csv')
  @RequirePermissions('reports:export', 'rewards:read')
  async exportCsv(@CurrentUser() auth: AuthContext, @Query() q: AdminRewardExportQueryDto, @Res() res: Response) {
    const where = await this.exports.beginAdminExport(auth, q);
    await streamCsv(res, csvFilename('rewards'), (sink) => this.exports.exportAdmin(where, q.order, sink));
  }

  @Post('bulk-approve')
  @HttpCode(200)
  @Idempotent()
  @RequirePermissions('rewards:approve')
  async bulkApprove(@CurrentUser() auth: AuthContext, @Body() body: BulkApproveRewardsDto) {
    return ok(await this.decisions.bulkApprove(auth, body.ids));
  }

  @Get(':id')
  @RequirePermissions('rewards:read')
  async get(@CurrentUser() auth: AuthContext, @Param() p: IdParamDto) {
    return ok(await this.query.getAdmin(auth, p.id));
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Idempotent()
  @RequirePermissions('rewards:approve')
  async approve(@CurrentUser() auth: AuthContext, @Param() p: IdParamDto) {
    return ok(await this.decisions.approve(auth, p.id));
  }

  @Post(':id/reject')
  @HttpCode(200)
  @Idempotent()
  @RequirePermissions('rewards:approve')
  async reject(@CurrentUser() auth: AuthContext, @Param() p: IdParamDto, @Body() body: RejectRewardDto) {
    return ok(await this.decisions.reject(auth, p.id, body.reason));
  }

  @Post(':id/reverse')
  @HttpCode(200)
  @Idempotent()
  @RequirePermissions('rewards:reverse')
  async reverse(@CurrentUser() auth: AuthContext, @Param() p: IdParamDto, @Body() body: ReverseRewardDto) {
    return ok(await this.decisions.reverse(auth, p.id, body.reason));
  }
}
