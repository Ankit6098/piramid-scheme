import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@app/shared';
import { type AuthContext, CurrentUser, IdParamDto, ok, RequirePermissions } from '../../common';
import { AdminMembersService } from './admin-members.service';
import { AdminMemberListQueryDto, AdminMemberRolesUpdateDto, AdminMemberStatusChangeDto } from './dto';

/**
 * Member management (/api/v1/admin/members) — HTTP only. PROGRAM_ADMIN scoping (members enrolled in
 * assigned programs) and the suspension/role rules live in AdminMembersService.
 * (`/admin/members/:id/team`, `/sponsor`, `/corrections` belong to the referrals module.)
 */
@ApiTags('admin: members')
@Controller('admin/members')
export class AdminMembersController {
  constructor(private readonly members: AdminMembersService) {}

  @Get()
  @RequirePermissions(Permission.MembersRead)
  @ApiOperation({ summary: 'Search members (name/email), filter by status, role, program' })
  list(@Query() q: AdminMemberListQueryDto, @CurrentUser() auth: AuthContext) {
    return this.members.list(auth, q);
  }

  @Get(':id')
  @RequirePermissions(Permission.MembersRead)
  @ApiOperation({ summary: 'Member profile, roles, enrollments, sponsor, team counts, reward summary, open flags' })
  async get(@Param() p: IdParamDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.members.get(auth, p.id));
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.MembersWrite)
  @ApiOperation({ summary: 'Suspend a member (reason; revokes their sessions; not yourself; admins only by a Super Admin)' })
  async suspend(@Param() p: IdParamDto, @Body() body: AdminMemberStatusChangeDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.members.suspend(auth, p.id, body.reason));
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.MembersWrite)
  @ApiOperation({ summary: 'Reactivate a suspended member (reason)' })
  async reactivate(@Param() p: IdParamDto, @Body() body: AdminMemberStatusChangeDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.members.reactivate(auth, p.id, body.reason));
  }

  @Put(':id/roles')
  @RequirePermissions(Permission.RolesAssign)
  @ApiOperation({ summary: 'Replace the roles of a member (reason; not yourself; revokes their sessions)' })
  async updateRoles(@Param() p: IdParamDto, @Body() body: AdminMemberRolesUpdateDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.members.updateRoles(auth, p.id, body));
  }
}
