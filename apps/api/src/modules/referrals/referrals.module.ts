import { Module } from '@nestjs/common';
import { ReferralsController } from './referrals.controller';
import { ReferralsService } from './referrals.service';
import { HierarchyService } from './hierarchy.service';

/** Referral codes, attribution at registration, team tree, admin corrections. */
@Module({
  imports: [],
  controllers: [ReferralsController],
  providers: [ReferralsService, HierarchyService],
  exports: [ReferralsService, HierarchyService],
})
export class ReferralsModule {}
