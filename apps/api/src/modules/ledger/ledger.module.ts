import { Module } from '@nestjs/common';
import { LedgerController } from './ledger.controller';
import { LedgerQueryService } from './ledger-query.service';
import { LedgerService } from './ledger.service';

/** Double-entry ledger postings/reversals (LedgerService), balances and reports (LedgerQueryService). */
@Module({
  imports: [],
  controllers: [LedgerController],
  providers: [LedgerService, LedgerQueryService],
  exports: [LedgerService, LedgerQueryService],
})
export class LedgerModule {}
