import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { formatAmount } from '@app/shared';
import { AuditService } from '../../common/audit/audit.service';
import { notFound } from '../../common/errors/app-error';
import { PrismaService, type Tx } from '../../common/prisma/prisma.service';
import { lockReferralTreeShared } from '../../common/prisma/referral-tree-lock';
import type { Prisma, QualifyingEventStatus } from '../../generated/prisma/client';
import { EnrollmentsService } from '../enrollments/enrollments.service';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { HierarchyService } from '../referrals/hierarchy.service';
import {
  ENGINE_VERSION,
  MAX_COMPRESSION_SEARCH_DEPTH,
  calculateRewards,
  checkBaseStorable,
  checkEventAgainstPolicy,
  serializeTrace,
  type CalcAncestor,
  type CalcPolicy,
} from './domain/reward-calculator';
import { STATUS_CHANGES_LOOKBACK, statusInForce } from './domain/program-status';
import { PlanPaymentLookalikeService } from './plan-payment-lookalike.service';

export type ProcessEventOutcome = 'REWARDS_CREATED' | 'NO_ELIGIBLE_RECIPIENTS' | 'ALREADY_PROCESSED' | 'REJECTED';

export interface ProcessEventResult {
  outcome: ProcessEventOutcome;
  /** Rewards created by THIS call (empty for ALREADY_PROCESSED / REJECTED / NO_ELIGIBLE_RECIPIENTS). */
  rewardIds: string[];
  /** Set when outcome = REJECTED. */
  rejectionReason?: string;
}

interface LockedEvent {
  id: string;
  status: QualifyingEventStatus;
  program_id: string;
  subject_user_id: string;
  source: string;
  type: CalcPolicy['triggerEventTypes'][number];
  external_id: string;
  amount_minor: bigint;
  currency_code: string;
  occurred_at: Date;
  created_at: Date;
}

/**
 * CROSS-MODULE CONTRACT: turns a RECEIVED qualifying event into rewards (business rules §8).
 * Consumed by the events slice right after intake and by the stuck-event sweeper.
 */
@Injectable()
export class RewardEngineService {
  private readonly logger = new Logger(RewardEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hierarchy: HierarchyService,
    private readonly enrollments: EnrollmentsService,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly lookalike: PlanPaymentLookalikeService,
  ) {}

  /**
   * Processes one event in its own transaction (do not call inside another transaction):
   * lock the event FOR UPDATE → ALREADY_PROCESSED unless RECEIVED → take the referral tree lock in
   * SHARED mode (waits for an in-flight sponsor correction) → validate (→ REJECTED with a
   * reason) → bind the applicable policy → calculate → insert the calculation and rewards → auto-post
   * when the policy skips approval, the sale did not come from a manual entry and it does not resemble
   * a plan payment (own or downline — such a sale is flagged for review instead) → mark PROCESSED →
   * notify recipients. Concurrent calls for the same event serialize on the row lock; exactly one
   * calculation is ever stored.
   */
  async processEvent(eventId: string): Promise<ProcessEventResult> {
    const result = await this.prisma.runInTransaction((tx) => this.processInTx(tx, eventId), { timeout: 30_000 });
    this.logger.log({ eventId, outcome: result.outcome, rewards: result.rewardIds.length }, 'event processed');
    return result;
  }

  private async processInTx(tx: Tx, eventId: string): Promise<ProcessEventResult> {
    const locked = await tx.$queryRaw<LockedEvent[]>`
      SELECT "id", "status", "program_id", "subject_user_id", "source"::text AS "source", "type", "external_id",
             "amount_minor", "currency_code"::text AS "currency_code", "occurred_at", "created_at"
      FROM "qualifying_events" WHERE "id" = ${eventId}::uuid FOR UPDATE`;
    const event = locked[0];
    if (!event) throw notFound('Qualifying event');
    if (event.status !== 'RECEIVED') return { outcome: 'ALREADY_PROCESSED', rewardIds: [] };

    // Hold the referral tree stable until COMMIT (business rules §6): a sponsor correction takes the
    // EXCLUSIVE lock, so it can neither interleave with this calculation nor slip in after its
    // "no RECEIVED sales in the moved subtree" check. Taken after the event row lock; corrections
    // never lock event rows, so the order cannot deadlock. Shared mode: sales and registrations
    // still run in parallel with each other.
    await lockReferralTreeShared(tx);

    const program = await tx.program.findUniqueOrThrow({
      where: { id: event.program_id },
      select: {
        id: true,
        name: true,
        status: true,
        endsAt: true,
        lateEventGraceDays: true,
        rewardUnit: true,
        currencyCode: true,
        currencyMinorUnits: true,
      },
    });

    const reject = async (reason: string): Promise<ProcessEventResult> => {
      await tx.qualifyingEvent.update({ where: { id: eventId }, data: { status: 'REJECTED', rejectionReason: reason } });
      await this.audit.record(tx, {
        actorUserId: null,
        action: 'event.rejected',
        resourceType: 'qualifying_event',
        resourceId: eventId,
        after: { status: 'REJECTED', reason },
      });
      return { outcome: 'REJECTED', rewardIds: [], rejectionReason: reason };
    };

    // ── Intake rules re-checked at processing time (business rules §8) ─────────
    const subject = await tx.user.findUnique({
      where: { id: event.subject_user_id },
      select: { status: true, emailVerifiedAt: true },
    });
    if (!subject || subject.status !== 'ACTIVE' || !subject.emailVerifiedAt) {
      return reject('The member credited with the sale is not an active member');
    }
    // Several changes may share one timestamp (one transaction): resolve the chain, not the SQL tie.
    const statusChanges = await tx.programStatusChange.findMany({
      where: { programId: program.id, changedAt: { lte: event.occurred_at } },
      orderBy: { changedAt: 'desc' },
      select: { fromStatus: true, toStatus: true, changedAt: true },
      take: STATUS_CHANGES_LOOKBACK,
    });
    if (statusInForce(statusChanges) !== 'ACTIVE') {
      return reject('The program was not active when the sale occurred');
    }
    if ((program.status === 'COMPLETED' || program.status === 'ARCHIVED') && program.endsAt) {
      const graceEnd = new Date(program.endsAt.getTime() + program.lateEventGraceDays * 86_400_000);
      if (Date.now() > graceEnd.getTime()) return reject('The late-recording window for this program has closed');
    }

    const policyRow = await tx.rewardPolicyVersion.findFirst({
      where: {
        programId: program.id,
        status: { in: ['PUBLISHED', 'RETIRED'] },
        effectiveFrom: { lte: event.occurred_at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: event.occurred_at } }],
      },
      include: { rules: { orderBy: { level: 'asc' } } },
    });
    if (!policyRow) return reject('No reward policy applies to the sale date');

    const policy: CalcPolicy = {
      id: policyRow.id,
      version: policyRow.version,
      maxDepth: policyRow.maxDepth,
      budgetBps: policyRow.budgetBps,
      maxTotalPerEventMinor: policyRow.maxTotalPerEventMinor,
      minEventAmountMinor: policyRow.minEventAmountMinor,
      ineligibleAncestorBehavior: policyRow.ineligibleAncestorBehavior,
      roundingMode: policyRow.roundingMode,
      triggerEventTypes: policyRow.triggerEventTypes,
      rules: policyRow.rules.map((r) => ({
        level: r.level,
        calcType: r.calcType,
        fixedAmountMinor: r.fixedAmountMinor,
        percentageBps: r.percentageBps,
        capMinor: r.capMinor,
      })),
    };
    const eventInput = { type: event.type, amountMinor: event.amount_minor };
    const policyProblem = checkEventAgainstPolicy(eventInput, policy);
    if (policyProblem) return reject(policyProblem);
    const unit = {
      rewardUnit: program.rewardUnit,
      currencyMinorUnits: program.currencyMinorUnits,
      pointsPerCurrencyUnit: policyRow.pointsPerCurrencyUnit,
    };
    // A POINTS base beyond bigint can never be stored: reject instead of failing forever.
    const storageProblem = checkBaseStorable(event.amount_minor, unit);
    if (storageProblem) return reject(storageProblem);

    // Bind the policy (the DB re-checks that it applies to this sale).
    await tx.qualifyingEvent.update({ where: { id: eventId }, data: { policyVersionId: policy.id } });

    // ── Recipients and eligibility, judged at the sale instant ─────────────────
    const searchDepth = policy.ineligibleAncestorBehavior === 'COMPRESS' ? MAX_COMPRESSION_SEARCH_DEPTH : policy.maxDepth;
    const ancestorRefs = await this.hierarchy.getAncestors(tx, event.subject_user_id, searchDepth);
    const ancestorIds = ancestorRefs.map((a) => a.userId);
    const users = await tx.user.findMany({
      where: { id: { in: ancestorIds } },
      select: { id: true, status: true, emailVerifiedAt: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));
    const eligibleEnrollments = policyRow.requireActiveEnrollment
      ? await this.enrollments.findEligibleEnrollments(tx, program.id, ancestorIds, event.occurred_at)
      : null;

    const ancestors: CalcAncestor[] = ancestorRefs.map((a) => {
      const u = userById.get(a.userId);
      let reason: string | undefined;
      if (!u || u.status !== 'ACTIVE') reason = 'account not active';
      else if (!u.emailVerifiedAt) reason = 'email not verified';
      else if (eligibleEnrollments && !eligibleEnrollments.has(a.userId)) reason = 'no eligible enrollment at the sale date';
      return { userId: a.userId, depth: a.depth, eligible: reason === undefined, ...(reason ? { ineligibleReason: reason } : {}) };
    });

    const calc = calculateRewards({ event: eventInput, policy, unit, ancestors });

    // Compliance (business rules §0.1): a sale with the amount of a plan payment by the subject or
    // their downline is processed, but its rewards always wait for a reviewer (the DB refuses an
    // auto-approved reward for it) and the subject is flagged once per sale.
    const lookalikes = await this.lookalike.find(tx, {
      subjectUserId: event.subject_user_id,
      amountMinor: event.amount_minor,
      currencyCode: event.currency_code,
      occurredAt: event.occurred_at,
      recordedAt: event.created_at,
    });
    if (lookalikes.length > 0) {
      await this.lookalike.raiseFlag(
        tx,
        {
          eventId,
          programId: program.id,
          externalId: event.external_id,
          subjectUserId: event.subject_user_id,
          amountMinor: event.amount_minor,
          currencyCode: event.currency_code,
        },
        lookalikes,
      );
    }

    // ── Persist ────────────────────────────────────────────────────────────────
    const calculationId = randomUUID();
    await tx.rewardCalculation.create({
      data: {
        id: calculationId,
        eventId,
        policyVersionId: policy.id,
        outcome: calc.allocations.length > 0 ? 'REWARDS_CREATED' : 'NO_ELIGIBLE_RECIPIENTS',
        rewardUnit: program.rewardUnit,
        currencyCode: program.currencyCode,
        currencyMinorUnits: program.currencyMinorUnits,
        pointsPerCurrencyUnit: policyRow.pointsPerCurrencyUnit,
        baseMinor: calc.baseMinor,
        budgetBps: policy.budgetBps,
        budgetMinor: calc.budgetMinor,
        totalAllocatedMinor: calc.totalAllocatedMinor,
        trace: serializeTrace(calc, {
          eventId,
          policyVersionId: policy.id,
          policyVersion: policy.version,
          ancestorsConsidered: ancestors.map((a) => ({
            userId: a.userId,
            depth: a.depth,
            eligible: a.eligible,
            reason: a.ineligibleReason ?? null,
          })),
        }) as Prisma.InputJsonValue,
        engineVersion: ENGINE_VERSION,
      },
    });

    const autoApprove = !policyRow.requiresApproval && event.source !== 'ADMIN_MANUAL' && lookalikes.length === 0;
    const now = new Date();
    const rewardIds: string[] = [];
    for (const allocation of calc.allocations) {
      const id = randomUUID();
      await tx.reward.create({
        data: {
          id,
          calculationId,
          eventId,
          programId: program.id,
          policyVersionId: policy.id,
          recipientUserId: allocation.recipientUserId,
          level: allocation.level,
          amountMinor: allocation.amountMinor,
          rewardUnit: program.rewardUnit,
          currencyCode: program.currencyCode,
          status: autoApprove ? 'APPROVED' : 'PENDING_APPROVAL',
          ...(autoApprove ? { approvedAt: now } : {}),
        },
      });
      rewardIds.push(id);
    }
    if (autoApprove) {
      for (const id of rewardIds) await this.ledger.postReward(tx, id, null);
    }

    await tx.qualifyingEvent.update({ where: { id: eventId }, data: { status: 'PROCESSED', processedAt: now } });
    await this.audit.record(tx, {
      actorUserId: null,
      action: 'event.processed',
      resourceType: 'qualifying_event',
      resourceId: eventId,
      after: {
        policyVersionId: policy.id,
        calculationId,
        rewards: rewardIds.length,
        totalAllocatedMinor: calc.totalAllocatedMinor.toString(),
        autoApproved: autoApprove,
        planPaymentLookalike: lookalikes.length > 0,
      },
    });

    if (calc.allocations.length > 0) {
      const settings = await tx.platformSettings.findUnique({ where: { id: 1 }, select: { pointsLabel: true } });
      const fmt = {
        unit: program.rewardUnit,
        currencyCode: program.currencyCode,
        minorUnits: program.currencyMinorUnits,
        pointsLabel: settings?.pointsLabel ?? 'Points',
      };
      for (const [i, allocation] of calc.allocations.entries()) {
        const rewardId = rewardIds[i]!;
        const amount = formatAmount(allocation.amountMinor, fmt);
        await this.notifications.notify(tx, {
          userId: allocation.recipientUserId,
          type: autoApprove ? 'reward.posted' : 'reward.pending',
          title: autoApprove ? 'You earned a reward' : 'New reward pending approval',
          body: autoApprove
            ? `${amount} from ${program.name} has been added to your earnings.`
            : `${amount} from ${program.name} is waiting for approval.`,
          data: { rewardId, programId: program.id },
          dedupeKey: `reward-created:${rewardId}`,
        });
      }
    }

    return { outcome: calc.allocations.length > 0 ? 'REWARDS_CREATED' : 'NO_ELIGIBLE_RECIPIENTS', rewardIds };
  }
}
