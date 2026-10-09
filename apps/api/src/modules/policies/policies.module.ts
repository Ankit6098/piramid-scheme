import { Module } from '@nestjs/common';
import { PoliciesController } from './policies.controller';

/** Reward policy versions + rules (draft/publish/retire), dry-run preview. */
@Module({
  imports: [],
  controllers: [PoliciesController],
  providers: [],
  exports: [],
})
export class PoliciesModule {}
