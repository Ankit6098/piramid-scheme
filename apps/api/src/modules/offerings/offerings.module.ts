import { Module } from '@nestjs/common';
import { AdminOfferingsController } from './offerings.controller';
import { OfferingsService } from './offerings.service';

/** Approved products/services (Offering) CRUD + approval. */
@Module({
  imports: [],
  controllers: [AdminOfferingsController],
  providers: [OfferingsService],
  exports: [OfferingsService],
})
export class OfferingsModule {}
