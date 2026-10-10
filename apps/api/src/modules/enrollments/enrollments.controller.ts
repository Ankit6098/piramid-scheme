import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { cancelMyEnrollmentSchema, Permission } from '@app/shared';
import { CurrentUser, IdParamDto, ok, RequirePermissions, type AuthContext } from '../../common';
import { parseOptionalBody } from '../programs/optional-body';
import {
  ActivateEnrollmentDto,
  CancelMyEnrollmentDto,
  CreateEnrollmentDto,
  EnrollmentDecisionDto,
  ListAdminEnrollmentsQueryDto,
  ListMyEnrollmentsQueryDto,
} from './dto';
import { EnrollmentsService } from './enrollments.service';

/** Member enrollments: enroll in a program, list and cancel own enrollments. */
@ApiTags('enrollments')
@Controller()
export class EnrollmentsController {
  constructor(private readonly enrollments: EnrollmentsService) {}

  @Post('programs/:id/enrollments')
  async enroll(@Param() p: IdParamDto, @Body() body: CreateEnrollmentDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.enrollments.enroll(auth, p.id, body));
  }

  @Get('users/me/enrollments')
  listMine(@Query() query: ListMyEnrollmentsQueryDto, @CurrentUser() auth: AuthContext) {
    return this.enrollments.listMine(auth, query);
  }

  @Post('users/me/enrollments/:id/cancel')
  @HttpCode(200)
  @ApiBody({ type: CancelMyEnrollmentDto, required: false })
  async cancelMine(@Param() p: IdParamDto, @Body() body: unknown, @CurrentUser() auth: AuthContext) {
    const input = parseOptionalBody(cancelMyEnrollmentSchema, body);
    return ok(await this.enrollments.cancelMine(auth, p.id, input.reason));
  }
}

/** Admin enrollment queue (`enrollments:manage`, scoped to assigned programs for PROGRAM_ADMINs). */
@ApiTags('admin/enrollments')
@Controller('admin/enrollments')
export class AdminEnrollmentsController {
  constructor(private readonly enrollments: EnrollmentsService) {}

  @Get()
  @RequirePermissions(Permission.EnrollmentsManage)
  list(@Query() query: ListAdminEnrollmentsQueryDto, @CurrentUser() auth: AuthContext) {
    return this.enrollments.adminList(auth, query);
  }

  @Get(':id')
  @RequirePermissions(Permission.EnrollmentsManage)
  async get(@Param() p: IdParamDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.enrollments.adminGet(auth, p.id));
  }

  @Post(':id/activate')
  @HttpCode(200)
  @RequirePermissions(Permission.EnrollmentsManage)
  async activate(@Param() p: IdParamDto, @Body() body: ActivateEnrollmentDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.enrollments.activate(auth, p.id, body));
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermissions(Permission.EnrollmentsManage)
  async reject(@Param() p: IdParamDto, @Body() body: EnrollmentDecisionDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.enrollments.reject(auth, p.id, body.reason));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermissions(Permission.EnrollmentsManage)
  async cancel(@Param() p: IdParamDto, @Body() body: EnrollmentDecisionDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.enrollments.adminCancel(auth, p.id, body.reason));
  }
}
