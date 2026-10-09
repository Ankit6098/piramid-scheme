import { Module } from '@nestjs/common';
import { RewardsModule } from '../rewards/rewards.module';
import { LedgerModule } from '../ledger/ledger.module';
import { EventsController } from './events.controller';

/** Qualifying event intake (idempotent), event reversal. */
@Module({
  imports: [RewardsModule, LedgerModule],
  controllers: [EventsController],
  providers: [],
  exports: [],
})
export class EventsModule {}
