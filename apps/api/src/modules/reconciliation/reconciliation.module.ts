import { Module } from '@nestjs/common';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationService } from './reconciliation.service';

/**
 * Reward ↔ ledger reconciliation report and exception counts. Exports ReconciliationService
 * (`countExceptions()` for the admin overview).
 */
@Module({
  imports: [],
  controllers: [ReconciliationController],
  providers: [ReconciliationService],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
