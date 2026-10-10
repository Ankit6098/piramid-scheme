import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { AdminController } from './admin.controller';
import { AdminMembersController } from './admin-members.controller';
import { AdminMembersService } from './admin-members.service';
import { AdminOverviewService } from './admin-overview.service';
import { MemberDashboardController } from './member-dashboard.controller';
import { MemberDashboardService } from './member-dashboard.service';

/** Admin overview aggregates, member management (status, roles, admin-triggered password reset) and the member dashboard. */
@Module({
  imports: [AuditModule, AuthModule, NotificationsModule, ReconciliationModule],
  controllers: [AdminController, AdminMembersController, MemberDashboardController],
  providers: [AdminOverviewService, AdminMembersService, MemberDashboardService],
  exports: [AdminMembersService],
})
export class AdminModule {}
