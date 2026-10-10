import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '@app/shared';
import { type AuthContext, CurrentUser, IdParamDto, ok, RequirePermissions } from '../../common';
import { AuditQueryService } from './audit-query.service';
import { AuditLogListQueryDto } from './dto';

/**
 * Audit log browsing (/api/v1/admin/audit) — HTTP only. Admin role + TOTP session are enforced by
 * SessionAuthGuard for every /admin route; `audit:read` here.
 */
@ApiTags('admin: audit')
@Controller('admin/audit')
export class AuditController {
  constructor(private readonly audit: AuditQueryService) {}

  @Get()
  @RequirePermissions(Permission.AuditRead)
  @ApiOperation({ summary: 'List audit entries (filters: actor, action prefix, resource, program, date range)' })
  list(@Query() q: AuditLogListQueryDto, @CurrentUser() auth: AuthContext) {
    return this.audit.list(auth, q);
  }

  @Get(':id')
  @RequirePermissions(Permission.AuditRead)
  @ApiOperation({ summary: 'One audit entry with before/after snapshots and a field-level diff' })
  async get(@Param() p: IdParamDto, @CurrentUser() auth: AuthContext) {
    return ok(await this.audit.get(auth, p.id));
  }
}
