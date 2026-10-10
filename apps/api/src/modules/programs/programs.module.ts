import { Module } from '@nestjs/common';
import { MemberProgramsService } from './member-programs.service';
import { ProgramAdminsService } from './program-admins.service';
import { ProgramLifecycleService } from './program-lifecycle.service';
import { ProgramOptionsService } from './program-options.service';
import { AdminProgramsController, ProgramsController } from './programs.controller';
import { ProgramsJobs } from './programs.jobs';
import { ProgramsService } from './programs.service';

/** Programs, options, lifecycle (publish/pause/complete/archive), admin assignments, scheduled status transitions. */
@Module({
  imports: [],
  controllers: [ProgramsController, AdminProgramsController],
  providers: [
    ProgramsService,
    ProgramLifecycleService,
    ProgramOptionsService,
    ProgramAdminsService,
    MemberProgramsService,
    ProgramsJobs,
  ],
  exports: [ProgramsService, ProgramLifecycleService],
})
export class ProgramsModule {}
