import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { type AuthContext, CurrentUser, ok } from '../../common';
import { MemberDashboardService } from './member-dashboard.service';

/** The signed-in member's dashboard (/api/v1/users/me/dashboard) — HTTP only, own data only. */
@ApiTags('dashboard')
@Controller('users/me/dashboard')
export class MemberDashboardController {
  constructor(private readonly dashboard: MemberDashboardService) {}

  @Get()
  @ApiOperation({ summary: 'My dashboard: verification, enrollments, team counts, reward totals, recent activity' })
  async get(@CurrentUser() auth: AuthContext) {
    return ok(await this.dashboard.getDashboard(auth));
  }
}
