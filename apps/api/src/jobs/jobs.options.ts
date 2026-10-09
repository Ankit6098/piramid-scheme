export const JOBS_OPTIONS = Symbol('JOBS_OPTIONS');

export interface JobsModuleOptions {
  /** 'worker' = dist/worker.js; 'api' = HTTP process (processes jobs only if RUN_WORKER_IN_API=true). */
  role: 'api' | 'worker';
  /** Resolved: whether this process runs the outbox relay and scheduled-job worker. */
  processing: boolean;
}
