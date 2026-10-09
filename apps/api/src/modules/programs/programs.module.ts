import { Module } from '@nestjs/common';
import { ProgramsController } from './programs.controller';

/** Programs, options, lifecycle (publish/pause/complete/archive), admin assignments, scheduled status transitions. */
@Module({
  imports: [],
  controllers: [ProgramsController],
  providers: [],
  exports: [],
})
export class ProgramsModule {}
