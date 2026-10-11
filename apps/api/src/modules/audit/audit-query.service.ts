import { Injectable } from '@nestjs/common';
import type { ApiPage, AuditLogDetailDto, AuditLogListItemDto, AuditLogListQuery, ProgramRefDto } from '@app/shared';
import { z } from 'zod';
import {
  type AuthContext,
  type Db,
  decodeCursor,
  notFound,
  paginate,
  PrismaService,
  programScopeFilter,
  validationFailed,
} from '../../common';
import { keysetWhere } from '../../common/pagination/keyset';
import type { Prisma } from '../../generated/prisma/client';
import { changedFieldsOf, diffAudit } from './domain/audit-diff';

const cursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });

const listSelect = {
  id: true,
  createdAt: true,
  action: true,
  resourceType: true,
  resourceId: true,
  programId: true,
  actorRoles: true,
  reason: true,
  before: true,
  after: true,
  actor: { select: { id: true, fullName: true } },
} satisfies Prisma.AuditLogSelect;

type AuditListRow = Prisma.AuditLogGetPayload<{ select: typeof listSelect }>;

/** Program filter for audit queries: everything, or only entries of the given programs. */
export type AuditScope = 'ALL' | readonly string[];

/**
 * Read side of the append-only audit trail (writing is `AuditService` in common/). Entries are only
 * shown to holders of `audit:read`; PROGRAM_ADMIN-scoped views (admin overview) only see entries
 * whose `programId` is one of their programs (business rules §13).
 */
@Injectable()
export class AuditQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(auth: AuthContext, q: AuditLogListQuery): Promise<ApiPage<AuditLogListItemDto>> {
    const scope = programScopeFilter(auth, 'read');
    if (scope !== 'ALL' && scope.length === 0) return { data: [], page: { nextCursor: null, limit: q.limit } };
    if (q.programId && scope !== 'ALL' && !scope.includes(q.programId)) {
      return { data: [], page: { nextCursor: null, limit: q.limit } };
    }
    const from = q.from ? new Date(q.from) : undefined;
    const to = q.to ? new Date(q.to) : undefined;
    if (from && to && from.getTime() > to.getTime()) {
      throw validationFailed('The start date must be before the end date', {
        issues: [{ path: 'from', message: 'Must be before "to"', code: 'custom' }],
      });
    }
    const cursor = decodeCursor(q.cursor, cursorSchema);

    const and: Prisma.AuditLogWhereInput[] = [];
    if (scope !== 'ALL') and.push({ programId: { in: [...scope] } });
    if (q.programId) and.push({ programId: q.programId });
    if (q.actorId) and.push({ actorUserId: q.actorId });
    if (q.action) and.push({ action: { startsWith: q.action } });
    if (q.resourceType) and.push({ resourceType: q.resourceType });
    if (q.resourceId) and.push({ resourceId: q.resourceId });
    if (from || to) and.push({ createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } });
    if (cursor) {
      const at = new Date(cursor.createdAt);
      and.push(keysetWhere<Prisma.AuditLogWhereInput>('createdAt', at, cursor.id, 'desc'));
    }

    const rows = await this.prisma.auditLog.findMany({
      where: and.length ? { AND: and } : {},
      select: listSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    const programs = await this.programRefs(this.prisma, rows.slice(0, q.limit));
    return paginate(
      rows,
      q.limit,
      (r) => ({ createdAt: r.createdAt.toISOString(), id: r.id }),
      (r) => this.toListItem(r, programs),
    );
  }

  async get(auth: AuthContext, id: string): Promise<AuditLogDetailDto> {
    const row = await this.prisma.auditLog.findUnique({
      where: { id },
      select: { ...listSelect, requestId: true, ipAddress: true },
    });
    const scope = programScopeFilter(auth, 'read');
    if (!row || (scope !== 'ALL' && (!row.programId || !scope.includes(row.programId)))) {
      throw notFound('Audit entry');
    }
    const programs = await this.programRefs(this.prisma, [row]);
    return {
      ...this.toListItem(row, programs),
      before: row.before ?? null,
      after: row.after ?? null,
      changes: diffAudit(row.before, row.after),
      requestId: row.requestId,
      ipAddress: row.ipAddress,
    };
  }

  /** Latest `limit` entries within `scope` (admin overview "recent admin actions"). */
  async recent(db: Db, scope: AuditScope, limit = 10): Promise<AuditLogListItemDto[]> {
    if (scope !== 'ALL' && scope.length === 0) return [];
    const rows = await db.auditLog.findMany({
      where: scope === 'ALL' ? {} : { programId: { in: [...scope] } },
      select: listSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    const programs = await this.programRefs(db, rows);
    return rows.map((r) => this.toListItem(r, programs));
  }

  private async programRefs(db: Db, rows: readonly AuditListRow[]): Promise<Map<string, ProgramRefDto>> {
    const ids = [...new Set(rows.map((r) => r.programId).filter((id): id is string => Boolean(id)))];
    if (!ids.length) return new Map();
    const programs = await db.program.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true } });
    return new Map(programs.map((p) => [p.id, p]));
  }

  private toListItem(row: AuditListRow, programs: ReadonlyMap<string, ProgramRefDto>): AuditLogListItemDto {
    return {
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      action: row.action,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      program: row.programId ? (programs.get(row.programId) ?? { id: row.programId, code: '', name: 'Deleted program' }) : null,
      actor: row.actor ? { id: row.actor.id, fullName: row.actor.fullName } : null,
      actorRoles: [...row.actorRoles],
      reason: row.reason,
      changedFields: changedFieldsOf(row.before, row.after),
    };
  }
}
