import { Injectable } from '@nestjs/common';
import { ScheduledJobsRegistry } from '../../jobs/scheduler/scheduled-jobs.registry';
import { ProgramLifecycleService } from './program-lifecycle.service';

export const PROGRAM_STATUS_JOB = 'programs-status-transitions';

/**
 * Registers the program status scheduler: SCHEDULED → ACTIVE at `startsAt`, ACTIVE/PAUSED →
 * COMPLETED at `endsAt` (every minute, idempotent, audited as system).
 */
@Injectable()
export class ProgramsJobs {
  constructor(registry: ScheduledJobsRegistry, lifecycle: ProgramLifecycleService) {
    registry.register({
      name: PROGRAM_STATUS_JOB,
      everyMs: 60_000,
      handler: async () => {
        await lifecycle.applyScheduledTransitions(new Date());
      },
    });
  }
}
