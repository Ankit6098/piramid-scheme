import { Module } from '@nestjs/common';
import { ReferralsModule } from '../referrals/referrals.module';
import { EnrollmentsModule } from '../enrollments/enrollments.module';
import { LedgerModule } from '../ledger/ledger.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminEventReversalController } from './admin-event-reversal.controller';
import { AdminRewardsController } from './admin-rewards.controller';
import { EventReversalService } from './event-reversal.service';
import { RewardDecisionsService } from './reward-decisions.service';
import { RewardEngineService } from './reward-engine.service';
import { RewardNotifier } from './reward-notifier';
import { RewardsController } from './rewards.controller';
import { RewardsExportService } from './rewards-export.service';
import { RewardsQueryService } from './rewards-query.service';

/** Reward engine, approvals, reversals (incl. event reversal), member rewards and earnings. */
@Module({
  imports: [ReferralsModule, EnrollmentsModule, LedgerModule, NotificationsModule],
  controllers: [RewardsController, AdminRewardsController, AdminEventReversalController],
  providers: [
    RewardEngineService,
    RewardsQueryService,
    RewardDecisionsService,
    EventReversalService,
    RewardsExportService,
    RewardNotifier,
  ],
  exports: [RewardEngineService, RewardsQueryService, RewardDecisionsService, EventReversalService],
})
export class RewardsModule {}
