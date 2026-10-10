import { Injectable } from '@nestjs/common';
import { ScheduledJobsRegistry } from '../../jobs/scheduler/scheduled-jobs.registry';
import { EnrollmentsService } from './enrollments.service';

export const ENROLLMENT_EXPIRY_JOB = 'enrollments-expiry';

/** Registers the enrollment expiry sweep (ACTIVE → EXPIRED once `effectiveTo` has passed; every 5 min). */
@Injectable()
export class EnrollmentsJobs {
  constructor(registry: ScheduledJobsRegistry, enrollments: EnrollmentsService) {
    registry.register({
      name: ENROLLMENT_EXPIRY_JOB,
      everyMs: 5 * 60_000,
      handler: async () => {
        await enrollments.expireDue(new Date());
      },
    });
  }
}
