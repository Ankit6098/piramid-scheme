import { Injectable } from '@nestjs/common';
import {
  Permission,
  type ApiPage,
  type IntegrationSaleResultDto,
  type listSaleEventsQuerySchema,
  type SaleEventDetailDto,
  type SaleEventDto,
  type SaleProgramOptionDto,
} from '@app/shared';
import { z } from 'zod';
import type { AuthContext } from '../../common/auth/auth-context';
import { assertProgramAccess, canAccessProgram, programScopeFilter } from '../../common/auth/program-access';
import { notFound } from '../../common/errors/app-error';
import { decodeCursor, paginate } from '../../common/pagination/cursor';
import { PrismaService, type Db } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import {
  saleEventDetailInclude,
  saleEventInclude,
  toIntegrationResultDto,
  toSaleEventDetailDto,
  toSaleEventDto,
  parseTrace,
  type RewardStats,
} from './event.mapper';

type ListQuery = z.output<typeof listSaleEventsQuerySchema>;

const listCursorSchema = z.object({ c: z.iso.datetime(), id: z.uuid() });
/** Programs that can receive sales (SCHEDULED/DRAFT ones have not run yet). */
const RECORDABLE_STATUSES = new Set(['ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED']);

/** Admin read side of sales events (business rules §8, §10: admin-only details). */
@Injectable()
export class EventsQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Programs visible to the caller, for filters and the "Record sale" form. */
  async programOptions(auth: AuthContext): Promise<SaleProgramOptionDto[]> {
    const scope = programScopeFilter(auth, 'read');
    if (scope !== 'ALL' && scope.length === 0) return [];
    const rows = await this.prisma.program.findMany({
      where: scope === 'ALL' ? {} : { id: { in: scope } },
      select: {
        id: true,
        code: true,
        name: true,
        status: true,
        rewardUnit: true,
        currencyCode: true,
        currencyMinorUnits: true,
        timezone: true,
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: 500,
    });
    const mayRecord = auth.permissions.has(Permission.EventsWrite);
    return rows.map((p) => ({
      ...p,
      canRecordSales: mayRecord && RECORDABLE_STATUSES.has(p.status) && canAccessProgram(auth, p.id, 'write'),
    }));
  }

  async list(auth: AuthContext, q: ListQuery): Promise<ApiPage<SaleEventDto>> {
    const scope = programScopeFilter(auth, 'read');
    if (q.programId) assertProgramAccess(auth, q.programId, 'read');
    const cursor = decodeCursor(q.cursor, listCursorSchema);
    const and: Prisma.QualifyingEventWhereInput[] = [];
    if (scope !== 'ALL') and.push({ programId: { in: scope } });
    if (q.programId) and.push({ programId: q.programId });
    if (q.status) and.push({ status: q.status });
    if (q.type) and.push({ type: q.type });
    if (q.source) and.push({ source: q.source });
    if (q.subjectUserId) and.push({ subjectUserId: q.subjectUserId });
    if (q.from) and.push({ occurredAt: { gte: new Date(q.from) } });
    if (q.to) and.push({ occurredAt: { lt: new Date(q.to) } });
    if (q.q) and.push({ OR: [{ externalId: q.q }, { customerReference: q.q }] });
    if (cursor) {
      const c = new Date(cursor.c);
      and.push({ OR: [{ createdAt: { lt: c } }, { createdAt: c, id: { lt: cursor.id } }] });
    }
    const rows = await this.prisma.qualifyingEvent.findMany({
      where: { AND: and },
      include: saleEventInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    const stats = await this.rewardStats(this.prisma, rows.slice(0, q.limit).map((r) => r.id));
    return paginate(
      rows,
      q.limit,
      (r) => ({ c: r.createdAt.toISOString(), id: r.id }),
      (r) => toSaleEventDto(r, stats.get(r.id) ?? { count: 0, totalMinor: 0n }),
    );
  }

  /** Admin detail (calculation trace + rewards). Pass `auth` to enforce program scope. */
  async getDetail(auth: AuthContext | null, id: string): Promise<SaleEventDetailDto> {
    const row = await this.prisma.qualifyingEvent.findUnique({ where: { id }, include: saleEventDetailInclude });
    if (!row) throw notFound('Sale event');
    if (auth) assertProgramAccess(auth, row.programId, 'read');

    const ancestorIds = row.calculation ? parseTrace(row.calculation.trace).ancestors.map((a) => a.userId) : [];
    const [users, revisions] = await Promise.all([
      ancestorIds.length
        ? this.prisma.user.findMany({ where: { id: { in: ancestorIds } }, select: { id: true, fullName: true } })
        : Promise.resolve([]),
      this.prisma.qualifyingEvent.findMany({
        where: { offeringId: row.offeringId, externalId: row.externalId },
        select: { id: true, revision: true, status: true, createdAt: true, programId: true },
        orderBy: { revision: 'asc' },
      }),
    ]);
    return toSaleEventDetailDto(row, {
      names: new Map(users.map((u) => [u.id, u.fullName])),
      revisions: revisions
        .filter((r) => r.programId === row.programId || !auth || canAccessProgram(auth, r.programId, 'read'))
        .map((r) => ({ id: r.id, revision: r.revision, status: r.status, createdAt: r.createdAt.toISOString() })),
    });
  }

  /** Minimal machine-facing view (no member or reward details). */
  async getIntegrationResult(id: string, replayed: boolean): Promise<IntegrationSaleResultDto> {
    const row = await this.prisma.qualifyingEvent.findUnique({ where: { id }, include: saleEventInclude });
    if (!row) throw notFound('Sale event');
    return toIntegrationResultDto(row, replayed);
  }

  private async rewardStats(db: Db, eventIds: string[]): Promise<Map<string, RewardStats>> {
    if (eventIds.length === 0) return new Map();
    const groups = await db.reward.groupBy({
      by: ['eventId'],
      where: { eventId: { in: eventIds } },
      _count: { _all: true },
      _sum: { amountMinor: true },
    });
    return new Map(groups.map((g) => [g.eventId, { count: g._count._all, totalMinor: g._sum.amountMinor ?? 0n }]));
  }
}
