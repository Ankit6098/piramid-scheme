import { Module } from '@nestjs/common';
import { EnrollmentsModule } from '../enrollments/enrollments.module';
import { ReferralsModule } from '../referrals/referrals.module';
import { AdminPoliciesController } from './admin-policies.controller';
import { PoliciesController } from './policies.controller';
import { PoliciesService } from './policies.service';

/** Reward policy versions + rules (draft/publish/retire), dry-run preview. */
@Module({
  imports: [ReferralsModule, EnrollmentsModule],
  controllers: [AdminPoliciesController, PoliciesController],
  providers: [PoliciesService],
  exports: [PoliciesService],
})
export class PoliciesModule {}
