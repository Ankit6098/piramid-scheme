import { Injectable, Logger } from '@nestjs/common';
import {
  QualifyingEventStatus,
  RewardStatus,
  type ReconciliationBucketDto,
  type ReconciliationExceptionDto,
  type ReconciliationReportDto,
} from '@app/shared';
import type { AuthContext } from '../../common/auth/auth-context';
import { programScopeFilter } from '../../common/auth/program-access';
import { forbidden } from '../../common/errors/app-error';
import { allLimited } from '../../common/prisma/concurrency';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { RewardUnit } from '../../generated/prisma/client';
import { PLAN_PAYMENT_FLAG_KIND } from '../rewards/domain/plan-payment';
import { CHECK_BY_KEY, summarizeChecks, type CheckOutcome } from './domain/checks';

/** How long a computed report is reused (the checks scan whole tables). */
export const RECONCILIATION_CACHE_TTL_MS = 60_000;
/** Oldest cached report whose count the admin overview may still show (refreshed in the background). */
export const RECONCILIATION_STALE_MAX_MS = 15 * 60_000;
/** Pool connections one report computation may use at once. */
export const RECONCILIATION_CONCURRENCY = 2;
/** Exception rows returned per check (counts are always exact). */
export const EXCEPTION_LIMIT_PER_CHECK = 100;

const s = (v: bigint | number | null | undefined) => (v === null || v === undefined ? null : v.toString());

/**
 * Reconciliation report (business rules §11): SQL checks that the reward state machine, the
 * double-entry ledger and member balances agree, plus the stuck-sale and plan-payment review queues.
 * Results are cached for ~60 s per process; `countExceptions()` feeds the admin overview.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private cached: { report: ReconciliationReportDto; at: number } | null = null;
  private inflight: Promise<ReconciliationReportDto> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** The report for an admin with `reconciliation:read` (it spans every program). */
  async getReport(auth: AuthContext, options: { refresh?: boolean } = {}): Promise<ReconciliationReportDto> {
    if (programScopeFilter(auth, 'read') !== 'ALL') {
      throw forbidden('The reconciliation report spans all programs and is available to finance reviewers only');
    }
    return this.report(options.refresh ?? false);
  }

  /**
   * CROSS-MODULE CONTRACT (admin overview): number of open exceptions of every check, including
   * compliance-review items. Stale-while-revalidate on the report cache: a cached count up to
   * RECONCILIATION_STALE_MAX_MS old is returned at once (a refresh starts in the background once it
   * is older than the ~60 s TTL), so the full-table checks run in the overview request only when
   * there is no usable report at all.
   */
  async countExceptions(): Promise<number> {
    const cached = this.cached;
    const age = cached ? Date.now() - cached.at : Infinity;
    if (cached && age < RECONCILIATION_STALE_MAX_MS) {
      if (age >= RECONCILIATION_CACHE_TTL_MS && !this.inflight) {
        this.report(true).catch((err: unknown) => this.logger.warn({ err }, 'background reconciliation refresh failed'));
      }
      return cached.report.totalExceptions;
    }
    return (await this.report(false)).totalExceptions;
  }

  /** Drops the cached report (tests, or after a corrective action). */
  invalidate(): void {
    this.cached = null;
  }

  async report(refresh = false): Promise<ReconciliationReportDto> {
    if (!refresh && this.cached && Date.now() - this.cached.at < RECONCILIATION_CACHE_TTL_MS) return this.cached.report;
    if (this.inflight) return this.inflight;
    this.inflight = this.compute()
      .then((report) => {
        this.cached = { report, at: Date.now() };
        if (!report.healthy) this.logger.warn({ totalExceptions: report.totalExceptions }, 'reconciliation exceptions found');
        return report;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async compute(): Promise<ReconciliationReportDto> {
    const generatedAt = new Date();
    // The checks scan whole tables: at most RECONCILIATION_CONCURRENCY pool connections at a time,
    // so a refresh never starves request traffic of connections.
    const outcomes: CheckOutcome[] = await allLimited(RECONCILIATION_CONCURRENCY, [
      () => this.rewardLedgerStatus(),
      () => this.ledgerAmounts(),
      () => this.unbalancedTransactions(),
      () => this.payableBalances(),
      () => this.reversedEventsWithLiveRewards(),
      () => this.calculationTotals(),
      () => this.stuckEvents(),
      () => this.planPaymentLookalikes(),
    ]);
    const { checks, totalExceptions, healthy } = summarizeChecks(outcomes);
    const [rewardsByStatus, eventsByStatus, buckets] = await allLimited(RECONCILIATION_CONCURRENCY, [
      () => this.rewardCounts(),
      () => this.eventCounts(),
      () => this.buckets(),
    ] as const);
    return {
      generatedAt: generatedAt.toISOString(),
      healthy,
      totalExceptions,
      checks,
      exceptions: outcomes.flatMap((o) => o.exceptions),
      exceptionLimitPerCheck: EXCEPTION_LIMIT_PER_CHECK,
      truncated: outcomes.some((o) => o.count > o.exceptions.length),
      summary: { rewardsByStatus, eventsByStatus, buckets },
    };
  }

  private exception(
    key: CheckOutcome['key'],
    e: Omit<ReconciliationExceptionDto, 'check' | 'severity'>,
  ): ReconciliationExceptionDto {
    return { check: key, severity: CHECK_BY_KEY.get(key)!.severity, ...e };
  }

  // ─── Checks ─────────────────────────────────────────────────────────────

  private async rewardLedgerStatus(): Promise<CheckOutcome> {
    const key = 'REWARD_LEDGER_STATUS_MISMATCH' as const;
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; program_id: string; status: string; postings: number; reversals: number; total: number }>
    >`
      WITH t AS (
        SELECT r."id", r."program_id", r."status"::text AS "status",
               count(lt."id") FILTER (WHERE lt."type" = 'REWARD_POSTING')::int AS "postings",
               count(lt."id") FILTER (WHERE lt."type" = 'REWARD_REVERSAL')::int AS "reversals"
          FROM "rewards" r
          LEFT JOIN "ledger_transactions" lt ON lt."reward_id" = r."id"
         GROUP BY r."id"
      )
      SELECT t.*, count(*) OVER ()::int AS "total" FROM t
       WHERE (t."status" = 'POSTED' AND (t."postings" <> 1 OR t."reversals" <> 0))
          OR (t."status" = 'REVERSED' AND (t."postings" <> 1 OR t."reversals" <> 1))
          OR (t."status" IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED') AND t."postings" + t."reversals" <> 0)
       ORDER BY t."id"
       LIMIT ${EXCEPTION_LIMIT_PER_CHECK}`;
    return {
      key,
      count: rows[0]?.total ?? 0,
      exceptions: rows.map((r) =>
        this.exception(key, {
          resourceType: 'reward',
          resourceId: r.id,
          programId: r.program_id,
          summary: `Reward is ${r.status} but has ${r.postings} posting(s) and ${r.reversals} reversal(s) in the ledger.`,
          details: { status: r.status, postings: r.postings, reversals: r.reversals },
        }),
      ),
    };
  }

  private async ledgerAmounts(): Promise<CheckOutcome> {
    const key = 'LEDGER_AMOUNT_MISMATCH' as const;
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; type: string; reward_id: string; program_id: string; debit_total_minor: bigint; reward_amount_minor: bigint; total: number }>
    >`
      SELECT t."id", t."type"::text AS "type", t."reward_id", r."program_id", t."debit_total_minor",
             r."amount_minor" AS "reward_amount_minor", count(*) OVER ()::int AS "total"
        FROM "ledger_transactions" t
        JOIN "rewards" r ON r."id" = t."reward_id"
       WHERE t."debit_total_minor" <> r."amount_minor"
          OR EXISTS (
               SELECT 1 FROM "ledger_entries" e
                WHERE e."transaction_id" = t."id"
                  AND (e."amount_minor" <> r."amount_minor" OR e."reward_unit" <> r."reward_unit" OR e."currency_code" <> r."currency_code"))
       ORDER BY t."posted_at" DESC, t."id"
       LIMIT ${EXCEPTION_LIMIT_PER_CHECK}`;
    return {
      key,
      count: rows[0]?.total ?? 0,
      exceptions: rows.map((r) =>
        this.exception(key, {
          resourceType: 'ledger_transaction',
          resourceId: r.id,
          programId: r.program_id,
          summary: `${r.type === 'REWARD_POSTING' ? 'Posting' : 'Reversal'} amount or entries differ from the reward amount.`,
          details: { type: r.type, rewardId: r.reward_id, transactionAmountMinor: s(r.debit_total_minor), rewardAmountMinor: s(r.reward_amount_minor) },
        }),
      ),
    };
  }

  private async unbalancedTransactions(): Promise<CheckOutcome> {
    const key = 'UNBALANCED_TRANSACTION' as const;
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; reward_id: string; program_id: string; entry_count: number; entries: number; debits: bigint; credits: bigint; debit_total_minor: bigint; total: number }>
    >`
      WITH sums AS (
        SELECT t."id", t."reward_id", t."entry_count"::int AS "entry_count", t."debit_total_minor",
               count(e."id")::int AS "entries",
               coalesce(sum(e."amount_minor") FILTER (WHERE e."direction" = 'DEBIT'), 0)::bigint AS "debits",
               coalesce(sum(e."amount_minor") FILTER (WHERE e."direction" = 'CREDIT'), 0)::bigint AS "credits"
          FROM "ledger_transactions" t
          LEFT JOIN "ledger_entries" e ON e."transaction_id" = t."id"
         GROUP BY t."id"
      )
      SELECT sums.*, r."program_id", count(*) OVER ()::int AS "total"
        FROM sums JOIN "rewards" r ON r."id" = sums."reward_id"
       WHERE sums."entries" <> sums."entry_count"
          OR sums."debits" <> sums."credits"
          OR sums."debits" <> sums."debit_total_minor"
          OR EXISTS (
               SELECT 1 FROM "ledger_entries" e WHERE e."transaction_id" = sums."id"
                GROUP BY e."reward_unit", e."currency_code"
               HAVING sum(CASE WHEN e."direction" = 'DEBIT' THEN e."amount_minor" ELSE -e."amount_minor" END) <> 0)
       ORDER BY sums."id"
       LIMIT ${EXCEPTION_LIMIT_PER_CHECK}`;
    return {
      key,
      count: rows[0]?.total ?? 0,
      exceptions: rows.map((r) =>
        this.exception(key, {
          resourceType: 'ledger_transaction',
          resourceId: r.id,
          programId: r.program_id,
          summary: `Debits ${s(r.debits)} vs credits ${s(r.credits)} across ${r.entries} of ${r.entry_count} expected entries.`,
          details: {
            rewardId: r.reward_id,
            entries: r.entries,
            expectedEntries: r.entry_count,
            debitsMinor: s(r.debits),
            creditsMinor: s(r.credits),
            headerTotalMinor: s(r.debit_total_minor),
          },
        }),
      ),
    };
  }

  private async payableBalances(): Promise<CheckOutcome> {
    const key = 'PAYABLE_BALANCE_MISMATCH' as const;
    const rows = await this.prisma.$queryRaw<
      Array<{ account_id: string | null; user_id: string; reward_unit: string; currency_code: string; balance: bigint; expected: bigint; total: number }>
    >`
      WITH bal AS (
        SELECT "account_id", "user_id", "reward_unit", "currency_code", ("credits_minor" - "debits_minor")::bigint AS "balance"
          FROM "ledger_account_balances" WHERE "type" = 'MEMBER_REWARDS_PAYABLE'
      ), exp AS (
        SELECT "recipient_user_id" AS "user_id", "reward_unit", "currency_code", sum("amount_minor")::bigint AS "expected"
          FROM "rewards" WHERE "status" = 'POSTED'
         GROUP BY "recipient_user_id", "reward_unit", "currency_code"
      )
      SELECT bal."account_id", coalesce(bal."user_id", exp."user_id") AS "user_id",
             coalesce(bal."reward_unit", exp."reward_unit")::text AS "reward_unit",
             coalesce(bal."currency_code", exp."currency_code") AS "currency_code",
             coalesce(bal."balance", 0)::bigint AS "balance", coalesce(exp."expected", 0)::bigint AS "expected",
             count(*) OVER ()::int AS "total"
        FROM bal
        FULL OUTER JOIN exp
          ON exp."user_id" = bal."user_id" AND exp."reward_unit" = bal."reward_unit" AND exp."currency_code" = bal."currency_code"
       WHERE coalesce(bal."balance", 0) <> coalesce(exp."expected", 0)
       ORDER BY 2, 3, 4
       LIMIT ${EXCEPTION_LIMIT_PER_CHECK}`;
    return {
      key,
      count: rows[0]?.total ?? 0,
      exceptions: rows.map((r) =>
        this.exception(key, {
          resourceType: r.account_id ? 'ledger_account' : 'member',
          resourceId: r.account_id ?? r.user_id,
          programId: null,
          summary: `Payable balance ${s(r.balance)} differs from posted − reversed rewards ${s(r.expected)} (${r.reward_unit} ${r.currency_code}).`,
          details: { memberId: r.user_id, rewardUnit: r.reward_unit, currencyCode: r.currency_code, balanceMinor: s(r.balance), expectedMinor: s(r.expected) },
        }),
      ),
    };
  }

  private async reversedEventsWithLiveRewards(): Promise<CheckOutcome> {
    const key = 'REVERSED_EVENT_LIVE_REWARDS' as const;
    const rows = await this.prisma.$queryRaw<Array<{ id: string; program_id: string; live: number; total: number }>>`
      SELECT e."id", e."program_id", count(r."id")::int AS "live", count(*) OVER ()::int AS "total"
        FROM "qualifying_events" e
        JOIN "rewards" r ON r."event_id" = e."id" AND r."status" IN ('PENDING_APPROVAL', 'APPROVED', 'POSTED')
       WHERE e."status" = 'REVERSED'
       GROUP BY e."id"
       ORDER BY e."id"
       LIMIT ${EXCEPTION_LIMIT_PER_CHECK}`;
    return {
      key,
      count: rows[0]?.total ?? 0,
      exceptions: rows.map((r) =>
        this.exception(key, {
          resourceType: 'qualifying_event',
          resourceId: r.id,
          programId: r.program_id,
          summary: `Reversed sale still has ${r.live} live reward(s).`,
          details: { liveRewards: r.live },
        }),
      ),
    };
  }

  private async calculationTotals(): Promise<CheckOutcome> {
    const key = 'CALCULATION_TOTAL_MISMATCH' as const;
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; program_id: string; status: string; calculation_id: string | null; calc_total: bigint | null; rewards_total: bigint; total: number }>
    >`
      SELECT e."id", e."program_id", e."status"::text AS "status", c."id" AS "calculation_id",
             c."total_allocated_minor" AS "calc_total", coalesce(sum(r."amount_minor"), 0)::bigint AS "rewards_total",
             count(*) OVER ()::int AS "total"
        FROM "qualifying_events" e
        LEFT JOIN "reward_calculations" c ON c."event_id" = e."id"
        LEFT JOIN "rewards" r ON r."calculation_id" = c."id"
       WHERE e."status" IN ('PROCESSED', 'REVERSED')
       GROUP BY e."id", c."id"
      HAVING c."id" IS NULL OR c."total_allocated_minor" <> coalesce(sum(r."amount_minor"), 0)
       ORDER BY e."id"
       LIMIT ${EXCEPTION_LIMIT_PER_CHECK}`;
    return {
      key,
      count: rows[0]?.total ?? 0,
      exceptions: rows.map((r) =>
        this.exception(key, {
          resourceType: 'qualifying_event',
          resourceId: r.id,
          programId: r.program_id,
          summary: r.calculation_id
            ? `Calculation total ${s(r.calc_total)} differs from the sum of its rewards ${s(r.rewards_total)}.`
            : `Sale is ${r.status} but has no calculation.`,
          details: { calculationId: r.calculation_id, calculationTotalMinor: s(r.calc_total), rewardsTotalMinor: s(r.rewards_total) },
        }),
      ),
    };
  }

  private async stuckEvents(): Promise<CheckOutcome> {
    const key = 'EVENT_STUCK_RECEIVED' as const;
    const rows = await this.prisma.$queryRaw<Array<{ id: string; program_id: string; external_id: string; created_at: Date; total: number }>>`
      SELECT "id", "program_id", "external_id", "created_at", count(*) OVER ()::int AS "total"
        FROM "qualifying_events"
       WHERE "status" = 'RECEIVED' AND "created_at" < now() - interval '15 minutes'
       ORDER BY "created_at" ASC, "id"
       LIMIT ${EXCEPTION_LIMIT_PER_CHECK}`;
    return {
      key,
      count: rows[0]?.total ?? 0,
      exceptions: rows.map((r) =>
        this.exception(key, {
          resourceType: 'qualifying_event',
          resourceId: r.id,
          programId: r.program_id,
          summary: `Sale ${r.external_id} has been waiting for processing since ${r.created_at.toISOString()}.`,
          details: { externalId: r.external_id, receivedAt: r.created_at.toISOString() },
        }),
      ),
    };
  }

  private async planPaymentLookalikes(): Promise<CheckOutcome> {
    const key = 'PLAN_PAYMENT_LOOKALIKE' as const;
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        program_id: string;
        subject_user_id: string;
        amount_minor: bigint;
        currency_code: string;
        status: string;
        enrollment_id: string;
        payer_user_id: string;
        payment_program_id: string;
        depth: number;
        payment_recorded_at: Date;
        matches: number;
        total: number;
      }>
    >`
      WITH m AS (
        SELECT DISTINCT ON (e."id") e."id", e."program_id", e."subject_user_id", e."amount_minor", e."currency_code",
               e."status"::text AS "status", e."occurred_at", pm."enrollment_id", pm."payer_user_id",
               pm."program_id" AS "payment_program_id", pm."depth", pm."payment_recorded_at",
               count(*) OVER (PARTITION BY e."id")::int AS "matches"
          FROM "qualifying_events" e
         CROSS JOIN LATERAL app_plan_payment_matches(e."subject_user_id", e."amount_minor", e."currency_code"::text,
                                                     e."occurred_at", e."created_at") pm
         WHERE e."status" NOT IN ('REJECTED', 'REVERSED')
           -- A reviewer resolved / dismissed the sale's PLAN_PAYMENT_LOOKALIKE flag: reviewed.
           AND NOT EXISTS (
                 SELECT 1 FROM "member_flags" f
                  WHERE f."dedupe_key" = ${`${PLAN_PAYMENT_FLAG_KIND}:`}::text || e."id"::text AND f."status" <> 'OPEN')
         ORDER BY e."id", pm."depth" ASC, pm."payment_recorded_at" DESC
      )
      SELECT m.*, count(*) OVER ()::int AS "total" FROM m
       ORDER BY m."occurred_at" DESC, m."id"
       LIMIT ${EXCEPTION_LIMIT_PER_CHECK}`;
    return {
      key,
      count: rows[0]?.total ?? 0,
      exceptions: rows.map((r) =>
        this.exception(key, {
          resourceType: 'qualifying_event',
          resourceId: r.id,
          programId: r.program_id,
          summary:
            r.depth === 0
              ? `Sale amount equals the credited member's own plan payment recorded ${r.payment_recorded_at.toISOString()}.`
              : `Sale amount equals a plan payment by a member ${r.depth} level(s) below the credited member, recorded ${r.payment_recorded_at.toISOString()}.`,
          details: {
            subjectUserId: r.subject_user_id,
            relation: r.depth === 0 ? 'OWN' : 'DOWNLINE',
            payerUserId: r.payer_user_id,
            depth: r.depth,
            enrollmentId: r.enrollment_id,
            paymentProgramId: r.payment_program_id,
            paymentRecordedAt: r.payment_recorded_at.toISOString(),
            matchingPayments: r.matches,
            amountMinor: s(r.amount_minor),
            currencyCode: r.currency_code,
            eventStatus: r.status,
          },
        }),
      ),
    };
  }

  // ─── Summary figures ────────────────────────────────────────────────────

  private async rewardCounts(): Promise<Record<RewardStatus, number>> {
    const groups = await this.prisma.reward.groupBy({ by: ['status'], _count: { _all: true } });
    const out = Object.fromEntries(RewardStatus.map((st) => [st, 0])) as Record<RewardStatus, number>;
    for (const g of groups) out[g.status] = g._count._all;
    return out;
  }

  private async eventCounts(): Promise<Record<QualifyingEventStatus, number>> {
    const groups = await this.prisma.qualifyingEvent.groupBy({ by: ['status'], _count: { _all: true } });
    const out = Object.fromEntries(QualifyingEventStatus.map((st) => [st, 0])) as Record<QualifyingEventStatus, number>;
    for (const g of groups) out[g.status] = g._count._all;
    return out;
  }

  private async buckets(): Promise<ReconciliationBucketDto[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        reward_unit: RewardUnit;
        currency_code: string;
        minor_units: number | null;
        rewards_posted: bigint;
        rewards_reversed: bigint;
        expected_payable: bigint;
        ledger_posted: bigint;
        ledger_reversed: bigint;
        payable_balance: bigint;
      }>
    >`
      WITH keys AS (
        SELECT DISTINCT "reward_unit", "currency_code" FROM "rewards" WHERE "status" IN ('POSTED', 'REVERSED')
        UNION
        SELECT DISTINCT "reward_unit", "currency_code" FROM "ledger_accounts"
      ),
      rw AS (
        SELECT "reward_unit", "currency_code",
               coalesce(sum("amount_minor") FILTER (WHERE "status" IN ('POSTED', 'REVERSED')), 0)::bigint AS "posted",
               coalesce(sum("amount_minor") FILTER (WHERE "status" = 'REVERSED'), 0)::bigint AS "reversed",
               coalesce(sum("amount_minor") FILTER (WHERE "status" = 'POSTED'), 0)::bigint AS "expected"
          FROM "rewards" GROUP BY "reward_unit", "currency_code"
      ),
      lt AS (
        SELECT r."reward_unit", r."currency_code",
               coalesce(sum(t."debit_total_minor") FILTER (WHERE t."type" = 'REWARD_POSTING'), 0)::bigint AS "posted",
               coalesce(sum(t."debit_total_minor") FILTER (WHERE t."type" = 'REWARD_REVERSAL'), 0)::bigint AS "reversed"
          FROM "ledger_transactions" t JOIN "rewards" r ON r."id" = t."reward_id"
         GROUP BY r."reward_unit", r."currency_code"
      ),
      pb AS (
        SELECT "reward_unit", "currency_code", coalesce(sum("credits_minor" - "debits_minor"), 0)::bigint AS "balance"
          FROM "ledger_account_balances" WHERE "type" = 'MEMBER_REWARDS_PAYABLE'
         GROUP BY "reward_unit", "currency_code"
      )
      SELECT k."reward_unit", k."currency_code", c."minor_units",
             coalesce(rw."posted", 0)::bigint AS "rewards_posted", coalesce(rw."reversed", 0)::bigint AS "rewards_reversed",
             coalesce(rw."expected", 0)::bigint AS "expected_payable",
             coalesce(lt."posted", 0)::bigint AS "ledger_posted", coalesce(lt."reversed", 0)::bigint AS "ledger_reversed",
             coalesce(pb."balance", 0)::bigint AS "payable_balance"
        FROM keys k
        LEFT JOIN rw ON rw."reward_unit" = k."reward_unit" AND rw."currency_code" = k."currency_code"
        LEFT JOIN lt ON lt."reward_unit" = k."reward_unit" AND lt."currency_code" = k."currency_code"
        LEFT JOIN pb ON pb."reward_unit" = k."reward_unit" AND pb."currency_code" = k."currency_code"
        LEFT JOIN "currencies" c ON c."code" = k."currency_code"
       ORDER BY k."reward_unit", k."currency_code"`;
    return rows.map((r) => ({
      rewardUnit: r.reward_unit,
      currencyCode: r.currency_code,
      currencyMinorUnits: r.minor_units ?? 0,
      rewardsPostedMinor: r.rewards_posted.toString(),
      ledgerPostedMinor: r.ledger_posted.toString(),
      rewardsReversedMinor: r.rewards_reversed.toString(),
      ledgerReversedMinor: r.ledger_reversed.toString(),
      payableBalanceMinor: r.payable_balance.toString(),
      expectedPayableMinor: r.expected_payable.toString(),
    }));
  }
}
