import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Permission } from '@app/shared';
import type { AuthContext } from '../../common/auth/auth-context';
import { CurrentUser, RequirePermissions } from '../../common/auth/decorators';
import { ok } from '../../common/http/envelope';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor';
import { IdParamDto } from '../../common/validation/zod';
import {
  CreatePolicyDraftDto,
  DryRunPolicyDto,
  ListPoliciesQueryDto,
  PublishPolicyDto,
  RetirePolicyDto,
  UpdatePolicyDraftDto,
  ValidatePolicyDto,
} from './dto';
import { PoliciesService } from './policies.service';

/**
 * Admin reward-policy routes (business rules §7). Program-scoped: the service calls
 * `assertProgramAccess` (PROGRAM_ADMIN → assigned programs; FINANCE_REVIEWER → read only).
 */
@ApiTags('admin: policies')
@Controller('admin')
export class AdminPoliciesController {
  constructor(private readonly policies: PoliciesService) {}

  @Get('programs/:id/policy-context')
  @RequirePermissions(Permission.ProgramsRead)
  async context(@Param() p: IdParamDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.policies.getContext(auth, p.id));
  }

  @Get('programs/:id/policies')
  @RequirePermissions(Permission.ProgramsRead)
  list(@Param() p: IdParamDto, @Query() q: ListPoliciesQueryDto, @CurrentUser() auth: AuthContext) {
    return this.policies.list(auth, p.id, q);
  }

  @Post('programs/:id/policies')
  @RequirePermissions(Permission.PoliciesWrite)
  async create(@Param() p: IdParamDto, @Body() body: CreatePolicyDraftDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.policies.createDraft(auth, p.id, body));
  }

  @Get('policies/:id')
  @RequirePermissions(Permission.ProgramsRead)
  async get(@Param() p: IdParamDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.policies.get(auth, p.id));
  }

  @Patch('policies/:id')
  @RequirePermissions(Permission.PoliciesWrite)
  async update(@Param() p: IdParamDto, @Body() body: UpdatePolicyDraftDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.policies.updateDraft(auth, p.id, body));
  }

  @Delete('policies/:id')
  @RequirePermissions(Permission.PoliciesWrite)
  async remove(@Param() p: IdParamDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.policies.deleteDraft(auth, p.id));
  }

  @Post('policies/:id/validate')
  @HttpCode(200)
  @RequirePermissions(Permission.PoliciesWrite)
  async validate(@Param() p: IdParamDto, @Body() body: ValidatePolicyDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.policies.validate(auth, p.id, body));
  }

  @Post('policies/:id/publish')
  @HttpCode(200)
  @Idempotent({ required: false })
  @RequirePermissions(Permission.PoliciesPublish)
  async publish(@Param() p: IdParamDto, @Body() body: PublishPolicyDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.policies.publish(auth, p.id, body));
  }

  @Post('policies/:id/retire')
  @HttpCode(200)
  @Idempotent({ required: false })
  @RequirePermissions(Permission.PoliciesPublish)
  async retire(@Param() p: IdParamDto, @Body() body: RetirePolicyDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.policies.retire(auth, p.id, body));
  }

  @Post('policies/:id/dry-run')
  @HttpCode(200)
  @RequirePermissions(Permission.PoliciesWrite)
  async dryRun(@Param() p: IdParamDto, @Body() body: DryRunPolicyDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.policies.dryRun(auth, p.id, body));
  }
}
