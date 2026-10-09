import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';

/** Admin overview/dashboard aggregates, member flags. */
@Module({
  imports: [],
  controllers: [AdminController],
  providers: [],
  exports: [],
})
export class AdminModule {}
