import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { type AuthContext, CurrentUser, ok } from '../../common';
import { AdminOverviewService } from './admin-overview.service';

/**
 * Admin overview (/api/v1/admin) — HTTP only. Every /admin route requires an admin role + a TOTP-verified
 * session (SessionAuthGuard); the overview is open to any admin, with figures scoped to the caller.
 */
@ApiTags('admin')
@Controller('admin')
export class AdminController {
  constructor(private readonly overview: AdminOverviewService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Dashboard aggregates (program-scoped for PROGRAM_ADMIN)' })
  async getOverview(@CurrentUser() auth: AuthContext) {
    return ok(await this.overview.getOverview(auth));
  }
}
