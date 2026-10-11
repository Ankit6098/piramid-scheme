import { Injectable } from '@nestjs/common';
import {
  RewardStatus,
  type AdminRewardAuditEntryDto,
  type AdminRewardCountsDto,
  type AdminRewardCountsQuery,
  type AdminRewardDetailDto,
  type AdminRewardFacetsDto,
  type AdminRewardFilters,
  type AdminRewardListQuery,
  type AdminRewardRowDto,
  type AdminRewardTraceDto,
  type ApiPage,
  type FinancePersonRef,
  type MemberEarningsDto,
  type MemberRewardDto,
  type MemberRewardFacetsDto,
  type MemberRewardFilters,
  type MemberRewardListQuery,
} from '@app/shared';
import { z } from 'zod';
import type { AuthContext } from '../../common/auth/auth-context';
import { assertProgramAccess, programScopeFilter } from '../../common/auth/program-access';
import { notFound } from '../../common/errors/app-error';
import { decodeCursor, paginate } from '../../common/pagination/cursor';
import { keysetWhere } from '../../common/pagination/keyset';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma, RewardUnit } from '../../generated/prisma/client';
import { resolveDateRange } from '../ledger/domain/date-range';
import { LedgerQueryService } from '../ledger/ledger-query.service';
import { PERSON_SELECT, personRef } from '../ledger/ledger-mappers';
import { buildEarningsBuckets } from './domain/member-view';
import { parseRewardTrace, traceUserIds } from './domain/trace';
import { PlanPaymentLookalikeService } from './plan-payment-lookalike.service';
import {
  ADMIN_REWARD_INCLUDE,
  MEMBER_REWARD_SELECT,
  toAdminRewardEvent,
  toAdminRewardRow,
  toMemberReward,
  toProgramRef,
} from './reward-mappers';

const rewardCursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });
const AUDIT_TRAIL_LIMIT = 100;
/** Rewards that still count for a sale (a recipient of one may not reverse the sale). */
const LIVE_REWARD_STATUSES: RewardStatus[] = ['PENDING_APPROVAL', 'APPROVED', 'POSTED'];

/** Keyset condition for (createdAt, id) in the given direction (index-friendly, see keysetWhere). */
export function createdAtKeyset(
  cursor: { createdAt: Date; id: string },
  order: 'asc' | 'desc',
): Prisma.RewardWhereInput {
  return keysetWhere<Prisma.RewardWhereInput>('createdAt', cursor.createdAt, cursor.id, order);
}

/**
 * Read side of rewards: the admin approval queue and detail (program-scoped for PROGRAM_ADMIN),
 * and members' own rewards and earnings (business rules §10 privacy).
 */
@Injectable()
export class RewardsQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerQuery: LedgerQueryService,
    private readonly lookalike: PlanPaymentLookalikeService,
  ) {}

  /** Per-row facts for a page of rewards: plan-payment lookalike sales, sales the viewer holds a live reward of. */
  private async rowContexts(eventIds: readonly string[], viewerId: string) {
    const ids = [...new Set(eventIds)];
    const [lookalikes, held] = await Promise.all([
      this.lookalike.lookalikeEventIds(this.prisma, ids),
      ids.length
        ? this.prisma.reward.findMany({
            where: { eventId: { in: ids }, recipientUserId: viewerId, status: { in: LIVE_REWARD_STATUSES } },
            select: { eventId: true },
          })
        : Promise.resolve([]),
    ]);
    const heldEvents = new Set(held.map((r) => r.eventId));
    return (eventId: string) => ({ planPaymentLookalike: lookalikes.has(eventId), saleRewardRecipient: heldEvents.has(eventId) });
  }

  // ─── Admin ──────────────────────────────────────────────────────────────

  /** Base `where` for admin lists/counts/exports: program scope + filters (except the cursor). */
  adminWhere(auth: AuthContext, f: Partial<AdminRewardFilters>): Prisma.RewardWhereInput {
    const scope = programScopeFilter(auth, 'read');
    if (f.programId) assertProgramAccess(auth, f.programId, 'read');
    const where: Prisma.RewardWhereInput = {};
    if (f.programId) where.programId = f.programId;
    else if (scope !== 'ALL') where.programId = { in: scope };
    if (f.status) where.status = f.status;
    if (f.recipientUserId) where.recipientUserId = f.recipientUserId;
    if (f.eventId) where.eventId = f.eventId;
    if (f.level) where.level = f.level;
    const createdAt = resolveDateRange(f.from, f.to);
    if (createdAt) where.createdAt = createdAt;
    if (f.q) {
      where.recipient = {
        OR: [{ fullName: { contains: f.q, mode: 'insensitive' } }, { email: { contains: f.q, mode: 'insensitive' } }],
      };
    }
    return where;
  }

  async listAdmin(auth: AuthContext, q: AdminRewardListQuery): Promise<ApiPage<AdminRewardRowDto>> {
    const cursor = decodeCursor(q.cursor, rewardCursorSchema);
    const and: Prisma.RewardWhereInput[] = [this.adminWhere(auth, q)];
    if (cursor) and.push(createdAtKeyset({ createdAt: new Date(cursor.createdAt), id: cursor.id }, q.order));
    const rows = await this.prisma.reward.findMany({
      where: { AND: and },
      include: ADMIN_REWARD_INCLUDE,
      orderBy: [{ createdAt: q.order }, { id: q.order }],
      take: q.limit + 1,
    });
    const ctx = await this.rowContexts(rows.slice(0, q.limit).map((r) => r.eventId), auth.userId);
    return paginate(
      rows,
      q.limit,
      (r) => ({ createdAt: r.createdAt.toISOString(), id: r.id }),
      (r) => toAdminRewardRow(r, auth.userId, ctx(r.eventId)),
    );
  }

  async countsAdmin(auth: AuthContext, q: AdminRewardCountsQuery): Promise<AdminRewardCountsDto> {
    const groups = await this.prisma.reward.groupBy({
      by: ['status'],
      where: this.adminWhere(auth, q),
      _count: { _all: true },
    });
    const byStatus = Object.fromEntries(RewardStatus.map((s) => [s, 0])) as Record<RewardStatus, number>;
    let total = 0;
    for (const g of groups) {
      byStatus[g.status] = g._count._all;
      total += g._count._all;
    }
    return { byStatus, total };
  }

  async facetsAdmin(auth: AuthContext): Promise<AdminRewardFacetsDto> {
    const scope = programScopeFilter(auth, 'read');
    const programs = await this.prisma.program.findMany({
      where: { rewards: { some: {} }, ...(scope === 'ALL' ? {} : { id: { in: scope } }) },
      select: { id: true, name: true, code: true, timezone: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: 500,
    });
    return { programs: programs.map(toProgramRef) };
  }

  async getAdmin(auth: AuthContext, id: string): Promise<AdminRewardDetailDto> {
    const row = await this.prisma.reward.findUnique({
      where: { id },
      include: {
        ...ADMIN_REWARD_INCLUDE,
        event: {
          select: {
            ...ADMIN_REWARD_INCLUDE.event.select,
            customerReference: true,
            description: true,
            processedAt: true,
            reversedAt: true,
            reversalReason: true,
          },
        },
        policyVersion: { select: { id: true, version: true, name: true, requiresApproval: true } },
        calculation: true,
      },
    });
    if (!row) throw notFound('Reward');
    assertProgramAccess(auth, row.programId, 'read');

    const [siblings, ledgerTransactions, audit, compliance, rowCtx] = await Promise.all([
      this.prisma.reward.findMany({
        where: { eventId: row.eventId, id: { not: row.id } },
        select: { id: true, level: true, status: true, amountMinor: true, rewardUnit: true, currencyCode: true, recipient: PERSON_SELECT },
        orderBy: { level: 'asc' },
      }),
      this.ledgerQuery.transactionsForReward(this.prisma, row.id),
      this.prisma.auditLog.findMany({
        where: {
          OR: [
            { resourceType: 'reward', resourceId: row.id },
            { resourceType: { in: ['qualifying_event', 'event'] }, resourceId: row.eventId },
          ],
        },
        include: { actor: PERSON_SELECT },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: AUDIT_TRAIL_LIMIT,
      }),
      this.prisma.qualifyingEvent
        .findUniqueOrThrow({
          where: { id: row.eventId },
          select: { id: true, subjectUserId: true, amountMinor: true, currencyCode: true, occurredAt: true, createdAt: true },
        })
        .then((e) => this.lookalike.compliance(this.prisma, e)),
      this.rowContexts([row.eventId], auth.userId),
    ]);

    const calc = row.calculation;
    const parsed = parseRewardTrace(calc.trace);
    const names = await this.userNames(traceUserIds(parsed));
    const trace: AdminRewardTraceDto = {
      ...parsed,
      levels: parsed.levels.map(({ userId, ...l }) => ({
        ...l,
        user: userId ? (names.get(userId) ?? { id: userId, fullName: 'Unknown member' }) : null,
        isThisReward: l.level === row.level && l.decision === 'AWARDED' && userId === row.recipientUserId,
      })),
      ancestors: parsed.ancestors.map((a) => ({ ...a, user: names.get(a.userId) ?? null })),
      raw: calc.trace,
    };

    const ctx = rowCtx(row.eventId);
    // The detail's compliance view is authoritative (it also covers a flag raised at processing).
    const base = toAdminRewardRow(row, auth.userId, { ...ctx, planPaymentLookalike: compliance.planPaymentLookalike });
    const minorUnits = row.program.currencyMinorUnits;
    return {
      ...base,
      event: {
        ...toAdminRewardEvent(row.event, compliance.planPaymentLookalike),
        customerReference: row.event.customerReference,
        description: row.event.description,
        processedAt: row.event.processedAt?.toISOString() ?? null,
        reversedAt: row.event.reversedAt?.toISOString() ?? null,
        reversalReason: row.event.reversalReason,
      },
      policyVersion: row.policyVersion,
      calculation: {
        id: calc.id,
        outcome: calc.outcome,
        engineVersion: calc.engineVersion,
        rewardUnit: calc.rewardUnit,
        currencyCode: calc.currencyCode,
        currencyMinorUnits: calc.currencyMinorUnits,
        pointsPerCurrencyUnit: calc.pointsPerCurrencyUnit,
        baseMinor: calc.baseMinor.toString(),
        budgetBps: calc.budgetBps,
        budgetMinor: calc.budgetMinor.toString(),
        totalAllocatedMinor: calc.totalAllocatedMinor.toString(),
        createdAt: calc.createdAt.toISOString(),
        trace,
      },
      siblings: siblings.map((s) => ({
        id: s.id,
        level: s.level,
        status: s.status,
        amountMinor: s.amountMinor.toString(),
        rewardUnit: s.rewardUnit,
        currencyCode: s.currencyCode,
        currencyMinorUnits: minorUnits,
        recipient: { id: s.recipient.id, fullName: s.recipient.fullName },
      })),
      ledgerTransactions,
      auditTrail: audit.map(
        (a): AdminRewardAuditEntryDto => ({
          id: a.id,
          action: a.action,
          resourceType: a.resourceType,
          actor: personRef(a.actor),
          actorRoles: a.actorRoles,
          reason: a.reason,
          before: a.before,
          after: a.after,
          createdAt: a.createdAt.toISOString(),
        }),
      ),
      compliance,
    };
  }

  // ─── Member ─────────────────────────────────────────────────────────────

  memberWhere(userId: string, f: MemberRewardFilters): Prisma.RewardWhereInput {
    const where: Prisma.RewardWhereInput = { recipientUserId: userId };
    if (f.status) where.status = f.status;
    if (f.programId) where.programId = f.programId;
    const createdAt = resolveDateRange(f.from, f.to);
    if (createdAt) where.createdAt = createdAt;
    return where;
  }

  async listMine(auth: AuthContext, q: MemberRewardListQuery): Promise<ApiPage<MemberRewardDto>> {
    const cursor = decodeCursor(q.cursor, rewardCursorSchema);
    const and: Prisma.RewardWhereInput[] = [this.memberWhere(auth.userId, q)];
    if (cursor) and.push(createdAtKeyset({ createdAt: new Date(cursor.createdAt), id: cursor.id }, 'desc'));
    const rows = await this.prisma.reward.findMany({
      where: { AND: and },
      select: { ...MEMBER_REWARD_SELECT },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    // The cursor needs createdAt/id: both are part of MEMBER_REWARD_SELECT.
    return paginate(rows, q.limit, (r) => ({ createdAt: r.createdAt.toISOString(), id: r.id }), toMemberReward);
  }

  async getMine(auth: AuthContext, id: string): Promise<MemberRewardDto> {
    const row = await this.prisma.reward.findFirst({ where: { id, recipientUserId: auth.userId }, select: MEMBER_REWARD_SELECT });
    if (!row) throw notFound('Reward');
    return toMemberReward(row);
  }

  async facetsMine(auth: AuthContext): Promise<MemberRewardFacetsDto> {
    const programs = await this.prisma.program.findMany({
      where: { rewards: { some: { recipientUserId: auth.userId } } },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return { programs };
  }

  /** Earned to date (ledger), pending and reversed per (unit, currency) — business rules §10. */
  async earnings(auth: AuthContext): Promise<MemberEarningsDto> {
    const [balances, sums, minorUnits] = await Promise.all([
      this.prisma.$queryRaw<Array<{ reward_unit: RewardUnit; currency_code: string; credits_minor: bigint; debits_minor: bigint }>>`
        SELECT "reward_unit", "currency_code", "credits_minor", "debits_minor"
          FROM "ledger_account_balances"
         WHERE "type" = 'MEMBER_REWARDS_PAYABLE' AND "user_id" = ${auth.userId}::uuid`,
      this.prisma.reward.groupBy({
        by: ['rewardUnit', 'currencyCode', 'status'],
        where: { recipientUserId: auth.userId },
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
      this.ledgerQuery.minorUnitsByCurrency(),
    ]);
    return {
      buckets: buildEarningsBuckets(
        balances.map((b) => ({
          rewardUnit: b.reward_unit,
          currencyCode: b.currency_code,
          creditsMinor: b.credits_minor,
          debitsMinor: b.debits_minor,
        })),
        sums.map((s) => ({
          rewardUnit: s.rewardUnit,
          currencyCode: s.currencyCode,
          status: s.status,
          amountMinor: s._sum.amountMinor ?? 0n,
          count: s._count._all,
        })),
        minorUnits,
      ),
    };
  }

  // ─── helpers ────────────────────────────────────────────────────────────

  private async userNames(ids: string[]): Promise<Map<string, FinancePersonRef>> {
    if (ids.length === 0) return new Map();
    const users = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } });
    return new Map(users.map((u) => [u.id, { id: u.id, fullName: u.fullName }]));
  }
}
