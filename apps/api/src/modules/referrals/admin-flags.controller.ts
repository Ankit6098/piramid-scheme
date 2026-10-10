import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Permission, type ApiPage, type ApiResponse, type FlagDto } from '@app/shared';
import type { AuthContext } from '../../common/auth/auth-context';
import { CurrentUser, RequirePermissions } from '../../common/auth/decorators';
import { ok } from '../../common/http/envelope';
import { IdParamDto } from '../../common/validation/zod';
import { CreateFlagDto, ListFlagsQueryDto, ResolveFlagDto } from './dto';
import { FlagsService } from './flags.service';

/** Suspicious-activity flags (/api/v1/admin/flags, `flags:manage`). */
@ApiTags('admin: flags')
@Controller('admin/flags')
@RequirePermissions(Permission.FlagsManage)
export class AdminFlagsController {
  constructor(private readonly flags: FlagsService) {}

  @Get()
  async list(@Query() q: ListFlagsQueryDto): Promise<ApiPage<FlagDto>> {
    return this.flags.list(q);
  }

  @Get(':id')
  async get(@Param() p: IdParamDto): Promise<ApiResponse<FlagDto>> {
    return ok(await this.flags.get(p.id));
  }

  @Post()
  async create(@CurrentUser() auth: AuthContext, @Body() body: CreateFlagDto): Promise<ApiResponse<FlagDto>> {
    return ok(await this.flags.create(auth, body));
  }

  @Post(':id/resolve')
  @HttpCode(200)
  async resolve(
    @CurrentUser() auth: AuthContext,
    @Param() p: IdParamDto,
    @Body() body: ResolveFlagDto,
  ): Promise<ApiResponse<FlagDto>> {
    return ok(await this.flags.resolve(auth, p.id, body));
  }
}
