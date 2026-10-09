import { Injectable, NotImplementedException } from '@nestjs/common';

export type ProcessEventOutcome = 'REWARDS_CREATED' | 'NO_ELIGIBLE_RECIPIENTS' | 'ALREADY_PROCESSED' | 'REJECTED';

export interface ProcessEventResult {
  outcome: ProcessEventOutcome;
  /** Rewards created by THIS call (empty for ALREADY_PROCESSED / REJECTED / NO_ELIGIBLE_RECIPIENTS). */
  rewardIds: string[];
}

/**
 * CROSS-MODULE CONTRACT (owned by the rewards slice; consumed by the events slice after intake).
 */
@Injectable()
export class RewardEngineService {
  /**
   * Processes a RECEIVED qualifying event in ONE transaction (business rules §8, "Persistence"):
   * locks the event `FOR UPDATE`; returns ALREADY_PROCESSED if it is no longer RECEIVED; validates
   * (→ event REJECTED with reason, outcome REJECTED); loads the applicable policy version, ancestors
   * (HierarchyService.getAncestors) and eligibility (EnrollmentsService.findEligibleEnrollments);
   * runs the pure calculator (`domain/reward-calculator.ts`); inserts reward_calculations + rewards
   * (PENDING_APPROVAL, or APPROVED + LedgerService.postReward when `requiresApproval = false`);
   * marks the event PROCESSED; enqueues member notifications via the outbox. Never recalculates.
   *
   * Opens its own transaction — do not call it inside another one.
   */
  async processEvent(eventId: string): Promise<ProcessEventResult> {
    void eventId;
    throw new NotImplementedException('rewards slice');
  }
}
