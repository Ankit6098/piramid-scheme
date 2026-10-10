import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthContext } from '../../common/auth/auth-context';
import { CurrentUser } from '../../common/auth/decorators';
import { ok } from '../../common/http/envelope';
import { IdParamDto } from '../../common/validation/zod';
import { csvFilename } from '../ledger/domain/csv';
import { streamCsv } from '../ledger/csv-response';
import { MemberRewardFiltersDto, MemberRewardListQueryDto } from './dto';
import { RewardsExportService } from './rewards-export.service';
import { RewardsQueryService } from './rewards-query.service';

/**
 * Member reward routes (/api/v1/users/me/rewards, /api/v1/users/me/earnings): the signed-in
 * member's own rewards only, with the fields of business rules §10 (no sale details, no trace).
 */
@ApiTags('rewards')
@Controller('users/me')
export class RewardsController {
  constructor(
    private readonly query: RewardsQueryService,
    private readonly exports: RewardsExportService,
  ) {}

  @Get('earnings')
  async earnings(@CurrentUser() auth: AuthContext) {
    return ok(await this.query.earnings(auth));
  }

  @Get('rewards')
  list(@CurrentUser() auth: AuthContext, @Query() q: MemberRewardListQueryDto) {
    return this.query.listMine(auth, q);
  }

  @Get('rewards/facets')
  async facets(@CurrentUser() auth: AuthContext) {
    return ok(await this.query.facetsMine(auth));
  }

  @Get('rewards/export.csv')
  async exportCsv(@CurrentUser() auth: AuthContext, @Query() q: MemberRewardFiltersDto, @Res() res: Response) {
    await streamCsv(res, csvFilename('my-rewards'), (sink) => this.exports.exportMine(auth, q, sink));
  }

  @Get('rewards/:id')
  async get(@CurrentUser() auth: AuthContext, @Param() p: IdParamDto) {
    return ok(await this.query.getMine(auth, p.id));
  }
}
