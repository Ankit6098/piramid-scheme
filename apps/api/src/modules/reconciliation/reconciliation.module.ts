import { Module } from '@nestjs/common';
import { ReconciliationController } from './reconciliation.controller';

/** Reward ↔ ledger reconciliation reports and exception counts. */
@Module({
  imports: [],
  controllers: [ReconciliationController],
  providers: [],
  exports: [],
})
export class ReconciliationModule {}
