import { Module } from '@nestjs/common';
import { OfferingsController } from './offerings.controller';

/** Approved products/services (Offering) CRUD. */
@Module({
  imports: [],
  controllers: [OfferingsController],
  providers: [],
  exports: [],
})
export class OfferingsModule {}
