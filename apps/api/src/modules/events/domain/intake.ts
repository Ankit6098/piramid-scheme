/**
 * Pure sales-intake rules (business rules §8): canonical request hashing, the replay / revision
 * decision for an (offering, externalId) pair, the intake validation that turns business-rule
 * failures into a stored REJECTED event, and the outcome shown to callers.
 */
import type {
  ProgramStatus,
  QualifyingEventStatus,
  QualifyingEventType,
  SaleCalculationOutcome,
  SaleIntakeOutcome,
  UserStatus,
} from '@app/shared';
import { computeRequestHash } from '../../../common/idempotency/request-hash';
import { checkBaseStorable, checkEventAgainstPolicy, type CalcPolicy, type CalcUnit } from '../../rewards/domain/reward-calculator';

export { PLAN_PAYMENT_WINDOW_MS } from '../../rewards/domain/plan-payment';

/** Sales may be dated at most this far in the future (clock skew; mirrors the DB check). */
export const FUTURE_SALE_TOLERANCE_MS = 5 * 60_000;

// ─── canonical request ───────────────────────────────────────────────────────

export interface SaleFacts {
  programId: string;
  type: QualifyingEventType;
  externalId: string;
  customerReference: string;
  subjectUserId: string;
  amountMinor: bigint;
  currencyCode: string;
  occurredAt: Date;
  supersedesEventId: string | null;
}

/**
 * `requestHash` = SHA-256 of the canonical sale facts. The channel (admin / API) and the free-text
 * description are deliberately not part of it: the same sale sent through two channels is the same
 * request; an explicit `supersedesEventId` makes a re-record a different request.
 */
export function saleRequestHash(f: SaleFacts): string {
  return computeRequestHash({
    v: 1,
    programId: f.programId,
    type: f.type,
    externalId: f.externalId,
    customerReference: f.customerReference,
    subjectUserId: f.subjectUserId,
    amountMinor: f.amountMinor.toString(),
    currencyCode: f.currencyCode,
    occurredAt: f.occurredAt.toISOString(),
    supersedesEventId: f.supersedesEventId,
  });
}

// ─── replay / revision decision ──────────────────────────────────────────────

export interface ExistingRevision {
  id: string;
  revision: number;
  status: QualifyingEventStatus;
  requestHash: string;
  /** The caller may see this revision's program (admin scope / the API client's program). */
  visible: boolean;
}

export type RevisionDecision =
  | { kind: 'replay'; eventId: string }
  | { kind: 'create'; revision: number; supersedesEventId: string | null }
  | {
      kind: 'conflict';
      /**
       * IDEMPOTENCY: same external id, different facts (never echoes the other event);
       * STALE_SUPERSEDE: `supersedesEventId` is not the latest revision;
       * NOT_SUPERSEDABLE: the latest revision is not REJECTED/REVERSED;
       * NOTHING_TO_SUPERSEDE: `supersedesEventId` given for a sale never recorded.
       */
      code: 'IDEMPOTENCY' | 'STALE_SUPERSEDE' | 'NOT_SUPERSEDABLE' | 'NOTHING_TO_SUPERSEDE';
    };

export function decideRevision(
  revisions: readonly ExistingRevision[],
  requestHash: string,
  supersedesEventId: string | null,
): RevisionDecision {
  const same = revisions.find((r) => r.requestHash === requestHash);
  if (same) return same.visible ? { kind: 'replay', eventId: same.id } : { kind: 'conflict', code: 'IDEMPOTENCY' };
  if (revisions.length === 0) {
    return supersedesEventId ? { kind: 'conflict', code: 'NOTHING_TO_SUPERSEDE' } : { kind: 'create', revision: 0, supersedesEventId: null };
  }
  const latest = revisions.reduce((a, b) => (b.revision > a.revision ? b : a));
  if (!latest.visible) return { kind: 'conflict', code: 'IDEMPOTENCY' };
  if (supersedesEventId && supersedesEventId !== latest.id) return { kind: 'conflict', code: 'STALE_SUPERSEDE' };
  if (latest.status === 'REJECTED' || latest.status === 'REVERSED') {
    return { kind: 'create', revision: latest.revision + 1, supersedesEventId: latest.id };
  }
  return { kind: 'conflict', code: supersedesEventId ? 'NOT_SUPERSEDABLE' : 'IDEMPOTENCY' };
}

// ─── intake validation ───────────────────────────────────────────────────────

export type IntakeRejectionCode =
  | 'FUTURE_SALE'
  | 'OUTSIDE_PROGRAM_PERIOD'
  | 'OFFERING_NOT_APPROVED'
  | 'PLAN_PAYMENT'
  | 'PROGRAM_NOT_ACTIVE'
  | 'LATE_WINDOW_CLOSED'
  | 'MEMBER_NOT_ACTIVE'
  | 'NO_POLICY'
  | 'POLICY_NOT_APPLICABLE'
  | 'AMOUNT_TOO_LARGE';

export interface IntakeEvaluationInput {
  now: Date;
  type: QualifyingEventType;
  amountMinor: bigint;
  occurredAt: Date;
  offeringActive: boolean;
  program: { status: ProgramStatus; startsAt: Date; endsAt: Date | null; lateEventGraceDays: number };
  /** Program status in force at `occurredAt` (from program_status_changes); null = none yet. */
  statusAtSale: ProgramStatus | null;
  subject: { status: UserStatus; emailVerified: boolean };
  /**
   * REFERENCE: the external id is an enrollment payment reference (of any program — references are
   * globally unique); AMOUNT: the subject's own plan payment of the same amount, in any program with
   * the sale's currency, recorded within ±2 days of the sale date or of now (business rules §0.1).
   * A downline member's matching payment is not a rejection (the sale is flagged for review instead).
   */
  planPayment: 'REFERENCE' | 'AMOUNT' | null;
  /** Non-draft version whose range contains `occurredAt`. */
  policy: CalcPolicy | null;
  /** Reward unit of the program and the policy's points rate (null without a policy). */
  unit: CalcUnit | null;
}

export interface IntakeRejection {
  code: IntakeRejectionCode;
  reason: string;
}

/**
 * First failing intake rule, or null when the sale may be processed. The row itself must already be
 * valid (offering = program offering, currency = program currency, subject exists, recorder SoD) —
 * these checks only decide RECEIVED vs REJECTED.
 */
export function evaluateIntake(i: IntakeEvaluationInput): IntakeRejection | null {
  const t = i.occurredAt.getTime();
  if (t > i.now.getTime() + FUTURE_SALE_TOLERANCE_MS) {
    return { code: 'FUTURE_SALE', reason: 'The sale date is in the future' };
  }
  if (t < i.program.startsAt.getTime() || (i.program.endsAt !== null && t >= i.program.endsAt.getTime())) {
    return { code: 'OUTSIDE_PROGRAM_PERIOD', reason: 'The sale date is outside the program period' };
  }
  if (!i.offeringActive) {
    return { code: 'OFFERING_NOT_APPROVED', reason: "The program's offering is not approved (active), so its sales cannot earn rewards" };
  }
  if (i.planPayment === 'REFERENCE') {
    return { code: 'PLAN_PAYMENT', reason: 'This id is a member plan payment, not a sale. Plan payments never earn rewards' };
  }
  if (i.planPayment === 'AMOUNT') {
    return {
      code: 'PLAN_PAYMENT',
      reason: "This looks like the member's own plan payment (same amount, recorded within 2 days of the sale or of now). Plan payments never earn rewards",
    };
  }
  if (i.statusAtSale !== 'ACTIVE') {
    return { code: 'PROGRAM_NOT_ACTIVE', reason: 'The program was not active when the sale occurred' };
  }
  if ((i.program.status === 'COMPLETED' || i.program.status === 'ARCHIVED') && i.program.endsAt) {
    const graceEnd = i.program.endsAt.getTime() + i.program.lateEventGraceDays * 86_400_000;
    if (i.now.getTime() > graceEnd) {
      return { code: 'LATE_WINDOW_CLOSED', reason: 'The late-recording window for this program has closed' };
    }
  }
  if (i.subject.status !== 'ACTIVE' || !i.subject.emailVerified) {
    return { code: 'MEMBER_NOT_ACTIVE', reason: 'The member credited with the sale is not an active member' };
  }
  if (!i.policy) {
    return { code: 'NO_POLICY', reason: 'No reward policy applies to the sale date' };
  }
  const problem = checkEventAgainstPolicy({ type: i.type, amountMinor: i.amountMinor }, i.policy);
  if (problem) return { code: 'POLICY_NOT_APPLICABLE', reason: problem };
  // POINTS: the converted base must fit a bigint, or the sale could never be processed.
  const storage = i.unit ? checkBaseStorable(i.amountMinor, i.unit) : null;
  if (storage) return { code: 'AMOUNT_TOO_LARGE', reason: storage };
  return null;
}

// ─── outcome ─────────────────────────────────────────────────────────────────

export function deriveOutcome(status: QualifyingEventStatus, calculationOutcome: SaleCalculationOutcome | null): SaleIntakeOutcome {
  switch (status) {
    case 'RECEIVED':
      return 'PENDING';
    case 'REJECTED':
      return 'REJECTED';
    case 'REVERSED':
      return 'REVERSED';
    case 'PROCESSED':
      return calculationOutcome ?? 'NO_ELIGIBLE_RECIPIENTS';
  }
}
