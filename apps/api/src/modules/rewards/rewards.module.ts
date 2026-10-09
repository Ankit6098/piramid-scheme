import { Module } from '@nestjs/common';
import { ReferralsModule } from '../referrals/referrals.module';
import { EnrollmentsModule } from '../enrollments/enrollments.module';
import { LedgerModule } from '../ledger/ledger.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RewardsController } from './rewards.controller';
import { RewardEngineService } from './reward-engine.service';

/** Reward engine, approvals, reversals, member earnings. */
@Module({
  imports: [ReferralsModule, EnrollmentsModule, LedgerModule, NotificationsModule],
  controllers: [RewardsController],
  providers: [RewardEngineService],
  exports: [RewardEngineService],
})
export class RewardsModule {}
