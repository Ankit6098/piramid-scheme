import { Injectable, Logger } from '@nestjs/common';
import type { AdminOverviewDto, AmountBucketDto, RewardUnit } from '@app/shared';
import { type AuthContext, hasPermission, PrismaService, programScopeFilter } from '../../common';
import { Prisma } from '../../generated/prisma/client';
import { AuditQueryService } from '../audit/audit-query.service';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { buildDailySeries, seriesStart } from './domain/admin-rules';

export const OVERVIEW_DAYS = 30;
/** Events still RECEIVED this long after being recorded count as reconciliation exceptions (§11). */
export const STUCK_EVENT_MINUTES = 15;
const DAY_MS = 86_400_000;

type Scope = 'ALL' | string[];

/**
 * Admin overview aggregates (GET /admin/overview). Figures are platform-wide for SUPER_ADMIN and
 * FINANCE_REVIEWER, and limited to the assigned programs for PROGRAM_ADMIN (members = members with an
 * enrollment in those programs). Amounts are summed per currency / reward unit, never across them.
 */
@Injectable()
export class AdminOverviewService {
  private readonly logger = new Logger(AdminOverviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditQuery: AuditQueryService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  async getOverview(auth: AuthContext, now: Date = new Date()): Promise<AdminOverviewDto> {
    const scope: Scope = programScopeFilter(auth, 'read');
    const scoped = scope !== 'ALL';
    const programIds = scoped ? scope : [];
    const programWhere = scoped ? { in: programIds } : undefined;
    const start = seriesStart(now, OVERVIEW_DAYS);
    const end = new Date(start.getTime() + OVERVIEW_DAYS * DAY_MS);
    const db = this.prisma;

    const [users, activePrograms, pendingEnrollments, sales, pending, posted, exceptions, openFlags, deadOutbox, recentActions, registrationsByDay, salesByDay, postedByDay] =
      await Promise.all([
        this.userCounts(scope),
        db.program.count({ where: { status: 'ACTIVE', ...(programWhere ? { id: programWhere } : {}) } }),
        db.programEnrollment.count({ where: { status: 'PENDING', ...(programWhere ? { programId: programWhere } : {}) } }),
        db.qualifyingEvent.groupBy({
          by: ['currencyCode'],
          where: {
            status: { in: ['RECEIVED', 'PROCESSED'] },
            occurredAt: { gte: start, lt: end },
            ...(programWhere ? { programId: programWhere } : {}),
          },
          _count: { _all: true },
          _sum: { amountMinor: true },
        }),
        db.reward.groupBy({
          by: ['rewardUnit', 'currencyCode'],
          where: { status: 'PENDING_APPROVAL', ...(programWhere ? { programId: programWhere } : {}) },
          _count: { _all: true },
          _sum: { amountMinor: true },
        }),
        db.reward.groupBy({
          by: ['rewardUnit', 'currencyCode'],
          where: { status: 'POSTED', ...(programWhere ? { programId: programWhere } : {}) },
          _count: { _all: true },
          _sum: { amountMinor: true },
        }),
        this.reconciliationExceptions(scope, now),
        scoped ? Promise.resolve(null) : db.memberFlag.count({ where: { status: 'OPEN' } }),
        auth.roles.includes('SUPER_ADMIN') ? db.outboxMessage.count({ where: { status: 'DEAD' } }) : Promise.resolve(null),
        this.recentActions(auth, scope),
        this.registrationsByDay(scope, start, end),
        this.salesByDay(scope, start, end),
        this.rewardsPostedByDay(scope, start, end),
      ]);

    const amountBuckets = (rows: typeof pending): AmountBucketDto[] =>
      rows
        .map((r) => ({
          rewardUnit: r.rewardUnit as RewardUnit,
          currencyCode: r.currencyCode.trim(),
          count: r._count._all,
          amountMinor: (r._sum.amountMinor ?? 0n).toString(),
        }))
        .sort((a, b) => a.rewardUnit.localeCompare(b.rewardUnit) || a.currencyCode.localeCompare(b.currencyCode));

    const salesByCurrency = sales
      .map((r) => ({ currencyCode: r.currencyCode.trim(), count: r._count._all, amountMinor: (r._sum.amountMinor ?? 0n).toString() }))
      .sort((a, b) => a.currencyCode.localeCompare(b.currencyCode));

    return {
      generatedAt: now.toISOString(),
      scope: scoped ? 'PROGRAMS' : 'ALL',
      scopedProgramCount: scoped ? programIds.length : null,
      users,
      activePrograms,
      pendingEnrollments,
      sales30d: { count: salesByCurrency.reduce((s, r) => s + r.count, 0), byCurrency: salesByCurrency },
      pendingRewardApprovals: { count: pending.reduce((s, r) => s + r._count._all, 0), byUnit: amountBuckets(pending) },
      postedRewards: amountBuckets(posted),
      reconciliation: exceptions,
      openFlags,
      deadOutboxMessages: deadOutbox,
      recentActions,
      daily: buildDailySeries(now, OVERVIEW_DAYS, {
        registrations: registrationsByDay,
        sales: salesByDay,
        rewardsPosted: postedByDay,
      }),
    };
  }

  /** Audit holders see every recent action; program-scoped admins only their programs' entries. */
  private recentActions(auth: AuthContext, scope: Scope) {
    if (hasPermission(auth, 'audit:read') && scope === 'ALL') return this.auditQuery.recent(this.prisma, 'ALL', 10);
    if (scope === 'ALL') return Promise.resolve([]);
    return this.auditQuery.recent(this.prisma, scope, 10);
  }

  private memberScopeSql(scope: Scope, alias: Prisma.Sql = Prisma.raw('u')): Prisma.Sql {
    if (scope === 'ALL') return Prisma.sql`TRUE`;
    return Prisma.sql`EXISTS (SELECT 1 FROM "program_enrollments" e WHERE e."user_id" = ${alias}."id" AND e."program_id" = ANY(${scope}::uuid[]))`;
  }

  private async userCounts(scope: Scope): Promise<AdminOverviewDto['users']> {
    if (scope !== 'ALL' && scope.length === 0) return { total: 0, verified: 0, suspended: 0 };
    const [row] = await this.prisma.$queryRaw<Array<{ total: number; verified: number; suspended: number }>>`
      SELECT count(*)::int AS "total",
             count(*) FILTER (WHERE u."email_verified_at" IS NOT NULL)::int AS "verified",
             count(*) FILTER (WHERE u."status" = 'SUSPENDED')::int AS "suspended"
      FROM "users" u
      WHERE ${this.memberScopeSql(scope)}`;
    return { total: row?.total ?? 0, verified: row?.verified ?? 0, suspended: row?.suspended ?? 0 };
  }

  private async registrationsByDay(scope: Scope, start: Date, end: Date): Promise<Map<string, number>> {
    if (scope !== 'ALL' && scope.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<Array<{ day: string; n: number }>>`
      SELECT to_char(u."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "day", count(*)::int AS "n"
      FROM "users" u
      WHERE u."created_at" >= ${start.toISOString()}::timestamptz AND u."created_at" < ${end.toISOString()}::timestamptz
        AND ${this.memberScopeSql(scope)}
      GROUP BY 1`;
    return new Map(rows.map((r) => [r.day, r.n]));
  }

  private async salesByDay(scope: Scope, start: Date, end: Date): Promise<Map<string, number>> {
    if (scope !== 'ALL' && scope.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<Array<{ day: string; n: number }>>`
      SELECT to_char(ev."occurred_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "day", count(*)::int AS "n"
      FROM "qualifying_events" ev
      WHERE ev."status" IN ('RECEIVED', 'PROCESSED')
        AND ev."occurred_at" >= ${start.toISOString()}::timestamptz AND ev."occurred_at" < ${end.toISOString()}::timestamptz
        ${scope === 'ALL' ? Prisma.empty : Prisma.sql`AND ev."program_id" = ANY(${scope}::uuid[])`}
      GROUP BY 1`;
    return new Map(rows.map((r) => [r.day, r.n]));
  }

  private async rewardsPostedByDay(scope: Scope, start: Date, end: Date): Promise<Map<string, number>> {
    if (scope !== 'ALL' && scope.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<Array<{ day: string; n: number }>>`
      SELECT to_char(lt."posted_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "day", count(*)::int AS "n"
      FROM "ledger_transactions" lt
      ${scope === 'ALL' ? Prisma.empty : Prisma.sql`JOIN "rewards" r ON r."id" = lt."reward_id"`}
      WHERE lt."type" = 'REWARD_POSTING'
        AND lt."posted_at" >= ${start.toISOString()}::timestamptz AND lt."posted_at" < ${end.toISOString()}::timestamptz
        ${scope === 'ALL' ? Prisma.empty : Prisma.sql`AND r."program_id" = ANY(${scope}::uuid[])`}
      GROUP BY 1`;
    return new Map(rows.map((r) => [r.day, r.n]));
  }

  /**
   * Platform-wide callers get the full reconciliation report count (`ReconciliationService`, cached
   * ~60 s). The report spans every program, so program-scoped admins — or a failing report — get the
   * built-in scoped subset instead.
   */
  private async reconciliationExceptions(scope: Scope, now: Date): Promise<AdminOverviewDto['reconciliation']> {
    if (scope === 'ALL') {
      try {
        return { exceptionCount: await this.reconciliation.countExceptions(), source: 'reconciliation' };
      } catch (err) {
        this.logger.warn({ err }, 'reconciliation report failed; using the basic exception count');
      }
    }
    return this.countBasicExceptions(scope, now);
  }

  /**
   * The two exception classes that occur in practice (business rules §11), optionally limited to
   * programs: rewards whose status disagrees with the ledger, and events stuck in RECEIVED for more
   * than 15 minutes. The other checks are impossible by DB construction.
   */
  private async countBasicExceptions(scope: Scope, now: Date): Promise<AdminOverviewDto['reconciliation']> {
    if (scope !== 'ALL' && scope.length === 0) return { exceptionCount: 0, source: 'basic' };
    const programFilter = (column: Prisma.Sql) =>
      scope === 'ALL' ? Prisma.empty : Prisma.sql`AND ${column} = ANY(${scope}::uuid[])`;
    const stuckBefore = new Date(now.getTime() - STUCK_EVENT_MINUTES * 60_000);
    const [row] = await this.prisma.$queryRaw<Array<{ mismatched: number; stuck: number }>>`
      SELECT
        (SELECT count(*)::int
           FROM "rewards" r
           LEFT JOIN "ledger_transactions" p ON p."reward_id" = r."id" AND p."type" = 'REWARD_POSTING'
           LEFT JOIN "ledger_transactions" v ON v."reward_id" = r."id" AND v."type" = 'REWARD_REVERSAL'
          WHERE ((r."status" = 'POSTED' AND (p."id" IS NULL OR v."id" IS NOT NULL))
              OR (r."status" = 'REVERSED' AND (p."id" IS NULL OR v."id" IS NULL))
              OR (r."status" IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED') AND (p."id" IS NOT NULL OR v."id" IS NOT NULL)))
            ${programFilter(Prisma.raw('r."program_id"'))}) AS "mismatched",
        (SELECT count(*)::int
           FROM "qualifying_events" ev
          WHERE ev."status" = 'RECEIVED' AND ev."created_at" < ${stuckBefore.toISOString()}::timestamptz
            ${programFilter(Prisma.raw('ev."program_id"'))}) AS "stuck"`;
    return { exceptionCount: (row?.mismatched ?? 0) + (row?.stuck ?? 0), source: 'basic' };
  }
}
