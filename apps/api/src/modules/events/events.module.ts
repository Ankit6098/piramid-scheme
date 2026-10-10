import { Module } from '@nestjs/common';
import { RewardsModule } from '../rewards/rewards.module';
import { LedgerModule } from '../ledger/ledger.module';
import { AdminEventsController } from './admin-events.controller';
import { EventIntakeService } from './event-intake.service';
import { EventsController } from './events.controller';
import { EventsJobs } from './events.jobs';
import { EventsQueryService } from './events-query.service';

/** Qualifying event intake (idempotent), event views, stuck-event sweeper. */
@Module({
  imports: [RewardsModule, LedgerModule],
  controllers: [EventsController, AdminEventsController],
  providers: [EventIntakeService, EventsQueryService, EventsJobs],
  exports: [EventIntakeService, EventsQueryService],
})
export class EventsModule {}
