import { Injectable } from '@nestjs/common';
import { ScheduledJobsRegistry } from '../../jobs/scheduler/scheduled-jobs.registry';
import { EventIntakeService } from './event-intake.service';

export const EVENTS_SWEEPER_JOB = 'events-received-sweeper';

/** Re-runs the reward engine for sales stuck in RECEIVED for more than 2 minutes (every minute). */
@Injectable()
export class EventsJobs {
  constructor(registry: ScheduledJobsRegistry, intake: EventIntakeService) {
    registry.register({
      name: EVENTS_SWEEPER_JOB,
      everyMs: 60_000,
      handler: async () => {
        await intake.sweepStuck();
      },
    });
  }
}
