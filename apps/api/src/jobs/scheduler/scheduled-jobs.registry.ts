import { Injectable } from '@nestjs/common';

export interface ScheduledJobDefinition {
  /** Unique kebab-case name, e.g. 'programs-status-transitions', 'auth-session-cleanup'. */
  name: string;
  /** Repeat every N milliseconds (≥ 1000)… */
  everyMs?: number;
  /** …or a cron pattern (5/6 fields), evaluated in `tz` (default UTC). */
  cron?: string;
  tz?: string;
  /**
   * The work. Runs in the worker process (or the API with RUN_WORKER_IN_API=true), one run at a
   * time per job across all workers. Must be idempotent — a run can be retried after a crash.
   */
  handler: () => Promise<void>;
}

/**
 * Registration API for recurring jobs (BullMQ job schedulers under the hood; see SchedulerRunner).
 * Slices register from a provider in their own module, e.g.
 *
 *   @Injectable()
 *   export class ProgramsJobs {
 *     constructor(registry: ScheduledJobsRegistry, private readonly programs: ProgramsService) {
 *       registry.register({ name: 'programs-status-transitions', everyMs: 60_000,
 *         handler: () => this.programs.applyScheduledTransitions(new Date()) });
 *     }
 *   }
 *
 * and add `ProgramsJobs` to the module's providers. Registration in the API process is harmless:
 * schedules are only installed/processed where job processing is enabled.
 */
@Injectable()
export class ScheduledJobsRegistry {
  private readonly jobs = new Map<string, ScheduledJobDefinition>();

  register(def: ScheduledJobDefinition): void {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(def.name)) throw new Error(`Invalid scheduled job name "${def.name}"`);
    if (this.jobs.has(def.name)) throw new Error(`Scheduled job "${def.name}" is already registered`);
    if (!def.cron && !def.everyMs) throw new Error(`Scheduled job "${def.name}" needs everyMs or cron`);
    if (def.cron && def.everyMs) throw new Error(`Scheduled job "${def.name}": use either everyMs or cron`);
    if (def.everyMs !== undefined && def.everyMs < 1000) throw new Error(`Scheduled job "${def.name}": everyMs must be ≥ 1000`);
    this.jobs.set(def.name, def);
  }

  get(name: string): ScheduledJobDefinition | undefined {
    return this.jobs.get(name);
  }

  list(): ScheduledJobDefinition[] {
    return [...this.jobs.values()];
  }

  /** Runs a job's handler directly (tests, manual triggers). */
  async runNow(name: string): Promise<void> {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`Unknown scheduled job "${name}"`);
    await job.handler();
  }
}
