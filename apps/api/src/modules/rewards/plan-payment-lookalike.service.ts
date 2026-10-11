import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { SaleComplianceDto } from '@app/shared';
import { AuditService } from '../../common/audit/audit.service';
import type { Db, Tx } from '../../common/prisma/prisma.service';
import {
  PLAN_PAYMENT_FLAG_KIND,
  planPaymentFlagDedupeKey,
  planPaymentFlagDetails,
  planPaymentRelation,
  planPaymentReviewMessage,
  sortPlanPaymentMatches,
  type PlanPaymentMatch,
} from './domain/plan-payment';

/** The facts of a sale that decide whether it resembles a plan payment. */
export interface PlanPaymentSaleFacts {
  subjectUserId: string;
  amountMinor: bigint;
  currencyCode: string;
  occurredAt: Date;
  /** When the sale was recorded (`created_at`; `now` before it is inserted). */
  recordedAt: Date;
}

const MATCH_LIMIT = 10;

/**
 * Plan-payment lookalike detection (business rules §0.1) over `app_plan_payment_matches()` — the same
 * SQL the event insert guard (own payments → refused) and the reward insert guard (no auto-approval
 * of lookalikes) use, so the application and the database always agree.
 */
@Injectable()
export class PlanPaymentLookalikeService {
  private readonly logger = new Logger(PlanPaymentLookalikeService.name);

  constructor(private readonly audit: AuditService) {}

  /** Matching plan payments, own first, then by depth (at most 10). */
  async find(db: Db, f: PlanPaymentSaleFacts): Promise<PlanPaymentMatch[]> {
    const rows = await db.$queryRaw<
      Array<{ enrollment_id: string; payer_user_id: string; program_id: string; depth: number; payment_recorded_at: Date }>
    >`
      SELECT "enrollment_id", "payer_user_id", "program_id", "depth", "payment_recorded_at"
        FROM app_plan_payment_matches(${f.subjectUserId}::uuid, ${f.amountMinor}::bigint, ${f.currencyCode}::text,
                                      ${f.occurredAt}::timestamptz, ${f.recordedAt}::timestamptz)
       ORDER BY "depth" ASC, "payment_recorded_at" DESC, "enrollment_id"
       LIMIT ${MATCH_LIMIT}`;
    return rows.map((r) => ({
      enrollmentId: r.enrollment_id,
      payerUserId: r.payer_user_id,
      programId: r.program_id,
      depth: Number(r.depth),
      paymentRecordedAt: r.payment_recorded_at,
    }));
  }

  /**
   * Events (of `eventIds`) that resemble a plan payment now, or were flagged as such when they were
   * processed. One query; used by the admin reward lists.
   */
  async lookalikeEventIds(db: Db, eventIds: readonly string[]): Promise<Set<string>> {
    if (eventIds.length === 0) return new Set();
    const ids = [...new Set(eventIds)];
    const rows = await db.$queryRaw<Array<{ id: string }>>`
      SELECT e."id"
        FROM "qualifying_events" e
       WHERE e."id" = ANY(${ids}::uuid[])
         AND (EXISTS (SELECT 1 FROM app_plan_payment_matches(e."subject_user_id", e."amount_minor", e."currency_code"::text,
                                                             e."occurred_at", e."created_at"))
              OR EXISTS (SELECT 1 FROM "member_flags" f
                          WHERE f."kind" = ${PLAN_PAYMENT_FLAG_KIND} AND f."dedupe_key" = ${`${PLAN_PAYMENT_FLAG_KIND}:`}::text || e."id"::text))`;
    return new Set(rows.map((r) => r.id));
  }

  /**
   * Raises the PLAN_PAYMENT_LOOKALIKE flag on the sale's credited member, once per sale: nothing
   * happens when a flag for this sale exists already (open, or already reviewed). Call inside the
   * transaction that records / processes the sale. Returns the flag id when one was created.
   */
  async raiseFlag(
    tx: Tx,
    sale: { eventId: string; programId: string; externalId: string; subjectUserId: string; amountMinor: bigint; currencyCode: string },
    matches: readonly PlanPaymentMatch[],
  ): Promise<string | null> {
    if (matches.length === 0) return null;
    const dedupeKey = planPaymentFlagDedupeKey(sale.eventId);
    const existing = await tx.memberFlag.findFirst({ where: { dedupeKey }, select: { id: true } });
    if (existing) return null;
    const details = planPaymentFlagDetails(sale, sortPlanPaymentMatches(matches));
    const [row] = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "member_flags" ("id", "user_id", "kind", "details", "status", "dedupe_key", "created_at", "updated_at")
      VALUES (${randomUUID()}::uuid, ${sale.subjectUserId}::uuid, ${PLAN_PAYMENT_FLAG_KIND}, ${details}, 'OPEN', ${dedupeKey}, now(), now())
      ON CONFLICT ("dedupe_key") WHERE "status" = 'OPEN' AND "dedupe_key" IS NOT NULL DO NOTHING
      RETURNING "id"`;
    if (!row) return null;
    await this.audit.record(tx, {
      actorUserId: null,
      action: 'flag.raise',
      resourceType: 'member_flag',
      resourceId: row.id,
      programId: sale.programId,
      after: {
        userId: sale.subjectUserId,
        kind: PLAN_PAYMENT_FLAG_KIND,
        status: 'OPEN',
        eventId: sale.eventId,
        matches: matches.length,
        relations: [...new Set(matches.map(planPaymentRelation))].join(','),
      },
    });
    this.logger.log({ eventId: sale.eventId, flagId: row.id }, 'sale resembles a plan payment; flag raised');
    return row.id;
  }

  /** Admin-only compliance view of a stored sale (names of payers and programs included). */
  async compliance(
    db: Db,
    event: { id: string; subjectUserId: string; amountMinor: bigint; currencyCode: string; occurredAt: Date; createdAt: Date },
  ): Promise<SaleComplianceDto> {
    const [matches, flag] = await Promise.all([
      this.find(db, {
        subjectUserId: event.subjectUserId,
        amountMinor: event.amountMinor,
        currencyCode: event.currencyCode,
        occurredAt: event.occurredAt,
        recordedAt: event.createdAt,
      }),
      db.memberFlag.findFirst({
        where: { dedupeKey: planPaymentFlagDedupeKey(event.id) },
        select: { id: true, status: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const [users, programs] = await Promise.all([
      matches.length
        ? db.user.findMany({ where: { id: { in: [...new Set(matches.map((m) => m.payerUserId))] } }, select: { id: true, fullName: true } })
        : Promise.resolve([]),
      matches.length
        ? db.program.findMany({ where: { id: { in: [...new Set(matches.map((m) => m.programId))] } }, select: { id: true, name: true } })
        : Promise.resolve([]),
    ]);
    const userName = new Map(users.map((u) => [u.id, u.fullName]));
    const programName = new Map(programs.map((p) => [p.id, p.name]));
    const lookalike = matches.length > 0 || flag !== null;
    return {
      planPaymentLookalike: lookalike,
      message: matches.length > 0
        ? planPaymentReviewMessage(matches)
        : flag
          ? 'When this sale was processed it had the same amount as a plan payment recorded within 2 days, so its rewards were held for manual approval.'
          : null,
      matches: matches.map((m) => ({
        relation: planPaymentRelation(m),
        depth: m.depth,
        enrollmentId: m.enrollmentId,
        program: { id: m.programId, name: programName.get(m.programId) ?? 'Unknown program' },
        payer: { id: m.payerUserId, fullName: userName.get(m.payerUserId) ?? 'Unknown member' },
        amountMinor: event.amountMinor.toString(),
        currencyCode: event.currencyCode,
        paymentRecordedAt: m.paymentRecordedAt.toISOString(),
      })),
      flag: flag ? { id: flag.id, status: flag.status } : null,
    };
  }
}
