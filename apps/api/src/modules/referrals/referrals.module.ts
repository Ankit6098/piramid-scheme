import { Module } from '@nestjs/common';
import { AdminFlagsController } from './admin-flags.controller';
import { AdminHierarchyService } from './admin-hierarchy.service';
import { AdminNetworkController } from './admin-network.controller';
import { FlagsService } from './flags.service';
import { FraudSignalsService } from './fraud-signals.service';
import { HierarchyService } from './hierarchy.service';
import { MemberNetworkController } from './member-network.controller';
import { ReferralCodesService } from './referral-codes.service';
import { ReferralsController } from './referrals.controller';
import { ReferralsService } from './referrals.service';
import { SponsorCorrectionService } from './sponsor-correction.service';
import { TeamTreeBuilder } from './team-tree.builder';
import { TeamRepository } from './team.repository';
import { TeamService } from './team.service';

/**
 * Referral codes, attribution at registration, sponsor/upline and team-tree views, admin hierarchy
 * views, audited sponsor corrections, suspicious-activity flags and the shared-IP fraud heuristic
 * (outbox topic `fraud.registration-attributed`).
 */
@Module({
  imports: [],
  controllers: [ReferralsController, MemberNetworkController, AdminNetworkController, AdminFlagsController],
  providers: [
    ReferralsService,
    HierarchyService,
    ReferralCodesService,
    TeamService,
    TeamRepository,
    TeamTreeBuilder,
    AdminHierarchyService,
    SponsorCorrectionService,
    FlagsService,
    FraudSignalsService,
  ],
  exports: [ReferralsService, HierarchyService],
})
export class ReferralsModule {}
