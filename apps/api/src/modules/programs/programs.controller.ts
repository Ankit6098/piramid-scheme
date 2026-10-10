import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { Permission, programLifecycleSchema, type ProgramLifecycleAction } from '@app/shared';
import { CurrentUser, IdParamDto, ok, RequirePermissions, type AuthContext } from '../../common';
import {
  CreateProgramDto,
  CreateProgramOptionDto,
  ListAdminProgramsQueryDto,
  ListMemberProgramsQueryDto,
  PauseProgramDto,
  ProgramIdOrCodeParamDto,
  ProgramLifecycleDto,
  ProgramOptionParamsDto,
  SetProgramAdminsDto,
  UpdateProgramDto,
  UpdateProgramOptionDto,
} from './dto';
import { MemberProgramsService } from './member-programs.service';
import { parseOptionalBody } from './optional-body';
import { ProgramAdminsService } from './program-admins.service';
import { ProgramLifecycleService } from './program-lifecycle.service';
import { ProgramOptionsService } from './program-options.service';
import { ProgramsService } from './programs.service';

/** Member catalogue: browsable programs and their plans (any signed-in user). */
@ApiTags('programs')
@Controller('programs')
export class ProgramsController {
  constructor(private readonly memberPrograms: MemberProgramsService) {}

  @Get()
  list(@Query() query: ListMemberProgramsQueryDto, @CurrentUser() auth: AuthContext) {
    return this.memberPrograms.list(auth, query);
  }

  @Get(':idOrCode')
  async get(@Param() p: ProgramIdOrCodeParamDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.memberPrograms.get(auth, p.idOrCode));
  }
}

/**
 * Admin programs. Program-scoped: PROGRAM_ADMINs only see/change programs assigned to them
 * (`assertProgramAccess` in the services); FINANCE_REVIEWERs read everything.
 */
@ApiTags('admin/programs')
@Controller('admin/programs')
export class AdminProgramsController {
  constructor(
    private readonly programs: ProgramsService,
    private readonly lifecycle: ProgramLifecycleService,
    private readonly options: ProgramOptionsService,
    private readonly admins: ProgramAdminsService,
  ) {}

  @Get()
  @RequirePermissions(Permission.ProgramsRead)
  list(@Query() query: ListAdminProgramsQueryDto, @CurrentUser() auth: AuthContext) {
    return this.programs.list(auth, query);
  }

  @Post()
  @RequirePermissions(Permission.ProgramsWrite)
  async create(@Body() body: CreateProgramDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.programs.create(auth, body));
  }

  @Get(':id')
  @RequirePermissions(Permission.ProgramsRead)
  async get(@Param() p: IdParamDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.programs.getDetail(auth, p.id));
  }

  @Patch(':id')
  @RequirePermissions(Permission.ProgramsWrite)
  async update(@Param() p: IdParamDto, @Body() body: UpdateProgramDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.programs.update(auth, p.id, body));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions(Permission.ProgramsWrite)
  async remove(@Param() p: IdParamDto, @CurrentUser() auth: AuthContext) {
    await this.programs.delete(auth, p.id);
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  @Post(':id/publish')
  @HttpCode(200)
  @RequirePermissions(Permission.ProgramsPublish)
  @ApiBody({ type: ProgramLifecycleDto, required: false })
  publish(@Param() p: IdParamDto, @Body() body: unknown, @CurrentUser() auth: AuthContext) {
    return this.lifecycleAction(auth, p.id, 'publish', body);
  }

  @Post(':id/pause')
  @HttpCode(200)
  @RequirePermissions(Permission.ProgramsPublish)
  async pause(@Param() p: IdParamDto, @Body() body: PauseProgramDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.lifecycle.transition(auth, p.id, 'pause', body));
  }

  @Post(':id/resume')
  @HttpCode(200)
  @RequirePermissions(Permission.ProgramsPublish)
  @ApiBody({ type: ProgramLifecycleDto, required: false })
  resume(@Param() p: IdParamDto, @Body() body: unknown, @CurrentUser() auth: AuthContext) {
    return this.lifecycleAction(auth, p.id, 'resume', body);
  }

  @Post(':id/complete')
  @HttpCode(200)
  @RequirePermissions(Permission.ProgramsPublish)
  @ApiBody({ type: ProgramLifecycleDto, required: false })
  complete(@Param() p: IdParamDto, @Body() body: unknown, @CurrentUser() auth: AuthContext) {
    return this.lifecycleAction(auth, p.id, 'complete', body);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermissions(Permission.ProgramsPublish)
  @ApiBody({ type: ProgramLifecycleDto, required: false })
  archive(@Param() p: IdParamDto, @Body() body: unknown, @CurrentUser() auth: AuthContext) {
    return this.lifecycleAction(auth, p.id, 'archive', body);
  }

  // ─── options ───────────────────────────────────────────────────────────────

  @Post(':id/options')
  @RequirePermissions(Permission.ProgramsWrite)
  async createOption(@Param() p: IdParamDto, @Body() body: CreateProgramOptionDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.options.create(auth, p.id, body));
  }

  @Patch(':id/options/:optionId')
  @RequirePermissions(Permission.ProgramsWrite)
  async updateOption(@Param() p: ProgramOptionParamsDto, @Body() body: UpdateProgramOptionDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.options.update(auth, p.id, p.optionId, body));
  }

  @Post(':id/options/:optionId/deactivate')
  @HttpCode(200)
  @RequirePermissions(Permission.ProgramsWrite)
  async deactivateOption(@Param() p: ProgramOptionParamsDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.options.update(auth, p.id, p.optionId, { isActive: false }));
  }

  @Post(':id/options/:optionId/activate')
  @HttpCode(200)
  @RequirePermissions(Permission.ProgramsWrite)
  async activateOption(@Param() p: ProgramOptionParamsDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.options.update(auth, p.id, p.optionId, { isActive: true }));
  }

  // ─── admin assignments ─────────────────────────────────────────────────────

  @Get(':id/admins')
  @RequirePermissions(Permission.ProgramsRead)
  async listAdmins(@Param() p: IdParamDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.admins.list(auth, p.id));
  }

  @Get(':id/admins/candidates')
  @RequirePermissions(Permission.RolesAssign)
  async adminCandidates() {
    return ok(await this.admins.candidates());
  }

  @Put(':id/admins')
  @RequirePermissions(Permission.RolesAssign)
  async setAdmins(@Param() p: IdParamDto, @Body() body: SetProgramAdminsDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.admins.set(auth, p.id, body));
  }

  private async lifecycleAction(auth: AuthContext, id: string, action: ProgramLifecycleAction, body: unknown) {
    const input = parseOptionalBody(programLifecycleSchema, body);
    return ok(await this.lifecycle.transition(auth, id, action, input));
  }
}
